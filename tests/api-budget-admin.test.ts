import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { applyMigrations, openDatabase } from '../apps/api/src/db';
import { ServerConfig, loadConfig } from '../apps/api/src/config';
import { startServer, type RunningServer } from '../apps/api/src/server';
import { recordProviderAttempt } from '../apps/worker/src/queue';
import {
  periodKeyFor,
  readReconciliationAudit,
  readUsageTotals,
  reserveBudget,
  settleReservation,
} from '../apps/worker/src/budget';

/**
 * R5's last gap: an uncertain charge has to be *resolvable*, not merely visible.
 *
 * A timed-out call may already have been billed, so its hold stays counted against the caps and
 * nothing releases it automatically. The budget module could settle one (`reconcileReservation`)
 * and had been tested at that level, but no route let a person do it, which meant the money was
 * counted forever and the only way to clear it was to open the database. This suite drives the
 * administrator path itself — list, decide, attribute — through the real HTTP server, with the
 * holds written by the real reservation code.
 *
 * The provider is deliberately unconfigured: none of this needs a credential, and it keeps the
 * test about accounting rather than generation.
 */

const scratch = mkdtempSync(join(tmpdir(), 'jevdeck-budget-admin-'));

const ADMIN_EMAIL = 'budget-admin@jevdeck.test';
const ADMIN_PASSWORD = 'a-sufficiently-long-admin-password';
const MEMBER_EMAIL = 'budget-member@jevdeck.test';

const dbPath = join(scratch, 'api.sqlite');

let db: Database;
let server: RunningServer;
let base: string;
let admin: Client;
let adminId = '';

function makeConfig(): ServerConfig {
  return {
    ...loadConfig({
      JEVDECK_DB_PATH: dbPath,
      JEVDECK_APP_ORIGIN: 'http://localhost:5173',
      JEVDECK_ALLOWED_ORIGINS: 'http://localhost:5173',
      JEVDECK_SECURE_COOKIES: 'false',
      // No worker: this suite never runs a job, and the holds it reconciles are written directly.
      JEVDECK_WORKER_ENABLED: 'false',
    }),
    port: 0,
  };
}

interface CallResult {
  status: number;
  body: any;
  headers: Headers;
}

/** A signed-in caller, carrying its own session cookie and CSRF token. */
class Client {
  private cookie: string | null = null;
  csrf: string | null = null;

  constructor(private readonly target: string) {}

  async call(
    path: string,
    options: { method?: string; body?: unknown } = {}
  ): Promise<CallResult> {
    const headers: Record<string, string> = {};
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    if (this.cookie) headers.cookie = this.cookie;
    if (this.csrf) headers['x-jevsession-csrf'] = this.csrf;

    const response = await fetch(`${this.target}${path}`, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });

    const cookieHeader = response.headers.get('set-cookie');
    if (cookieHeader) {
      const [pair] = cookieHeader.split(';');
      const value = pair.slice(pair.indexOf('=') + 1).trim();
      this.cookie = value.length === 0 ? null : pair.trim();
    }

    const text = await response.text();
    let body: any = null;
    if (text.length > 0) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }

    if (body && typeof body.csrfToken === 'string') this.csrf = body.csrfToken;

    return { status: response.status, body, headers: response.headers };
  }
}

/** The period the report summarises, so every figure here is the one enforcement used. */
const periodKey = periodKeyFor(new Date());

/**
 * Puts one hold into `reconciling` for a real account.
 *
 * The state a timeout leaves behind, written by the same reservation code the pipeline uses: the
 * money is counted, and only a person can resolve it.
 */
function uncertainHold(input: { userId: string; attemptId: string; amountMinor: number }): string {
  const held = reserveBudget(db, {
    userId: input.userId,
    jobId: null,
    attemptId: input.attemptId,
    amountMinor: input.amountMinor,
    currency: 'USD',
    periodKey,
    model: 'stub-model',
  });
  if (!held.ok) throw new Error('The test hold was refused; the cap configuration is wrong.');

  settleReservation(db, {
    reservationId: held.reservationId,
    outcome: 'reconciling',
    amountMinor: input.amountMinor,
    source: 'estimated',
    priceVersion: 'prices-v2+env+unknown-model+model:stub-model',
    currency: 'USD',
  });

  return held.reservationId;
}

/** Removes only the rows a test wrote, so the next test starts from the same place. */
function clearChargesFor(userId: string): void {
  db.prepare('DELETE FROM budget_reservations WHERE user_id = ? AND period_key = ?').run(
    userId,
    periodKey
  );
  db.prepare('DELETE FROM usage_records WHERE user_id = ? AND period_key = ?').run(
    userId,
    periodKey
  );
}

function ledgerRowsFor(userId: string): Array<{ amount_minor: number; source: string }> {
  return db
    .query(
      'SELECT amount_minor, source FROM usage_records WHERE user_id = ? AND period_key = ? ORDER BY recorded_at ASC, rowid ASC'
    )
    .all(userId, periodKey) as Array<{ amount_minor: number; source: string }>;
}

/** What the append-only ledger says the period cost, which is the record of spend itself. */
function ledgerTotalFor(userId: string): number {
  return ledgerRowsFor(userId).reduce((total, row) => total + row.amount_minor, 0);
}

let member: Client;
let memberId = '';

beforeAll(async () => {
  db = openDatabase(dbPath);
  applyMigrations(db);

  server = startServer(db, makeConfig());
  base = `http://127.0.0.1:${server.port}`;
  admin = new Client(base);

  const bootstrapped = await admin.call('/api/bootstrap', {
    method: 'POST',
    body: { email: ADMIN_EMAIL, name: 'Budget Administrator', password: ADMIN_PASSWORD },
  });
  expect(bootstrapped.status).toBe(201);
  adminId = bootstrapped.body.user.id as string;

  // A second, ordinary account, so "an administrator only" is checked against a real session
  // rather than only against an absent cookie.
  const issued = await admin.call('/api/admin/invitations', {
    method: 'POST',
    body: { email: MEMBER_EMAIL, role: 'member' },
  });
  expect(issued.status).toBe(201);

  member = new Client(base);
  const accepted = await member.call('/api/invitations/accept', {
    method: 'POST',
    body: {
      token: issued.body.token,
      name: 'Budget Member',
      password: 'a-sufficiently-long-member-password',
    },
  });
  expect(accepted.status).toBe(201);
  memberId = accepted.body.user.id as string;
});

afterAll(() => {
  try {
    server?.stop(true);
    db?.close();
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

describe('The administrator can see what is waiting on a decision', () => {
  it('lists it with the context needed to decide, and with enforcement\u2019s own figures', async () => {
    try {
      const reservationId = uncertainHold({
        userId: adminId,
        attemptId: 'pat_list_uncertain',
        amountMinor: 512,
      });

      const report = await admin.call('/api/admin/budget');
      expect(report.status).toBe(200);

      const listed = report.body.budget.uncertain.find(
        (row: any) => row.reservationId === reservationId
      );

      // Reachable from the screen, with enough of its origin to decide it: whose it is, which
      // model it was priced for, which attempt it belongs to, and which period it counts against.
      expect(listed).toBeDefined();
      expect(listed.amountMinor).toBe(512);
      expect(listed.periodKey).toBe(periodKey);
      expect(listed.userId).toBe(adminId);
      expect(listed.userEmail).toBe(ADMIN_EMAIL);
      expect(listed.model).toBe('stub-model');
      expect(listed.attemptId).toBe('pat_list_uncertain');
      expect(listed.jobId).toBeNull();
      expect(listed.createdAt).toBeTypeOf('string');

      // The figures on the screen are the figures enforcement used, not a second reading of them.
      const totals = readUsageTotals(db, periodKey);
      expect(report.body.budget.reconcilingMinor).toBe(totals.reconcilingMinor);
      expect(report.body.budget.committedMinor).toBe(totals.committedMinor);
      expect(totals.reconcilingMinor).toBeGreaterThanOrEqual(512);

      // And each account's position, which the roster shows, comes from the same rows.
      const perUser = report.body.budget.perUser.find((row: any) => row.userId === adminId);
      expect(perUser).toBeDefined();
      expect(perUser.committedMinor).toBe(readUsageTotals(db, periodKey, adminId).committedMinor);
      expect(perUser.reconcilingMinor).toBeGreaterThanOrEqual(512);
    } finally {
      clearChargesFor(adminId);
    }
  });

  it('reports a charge that came in above its hold as an incident', async () => {
    try {
      // A real attempt row, so the charge can be traced to the call that produced it.
      const attemptRowId = recordProviderAttempt(db, {
        jobId: null,
        ownerId: adminId,
        attemptId: 'pat_overspend_incident',
        phase: 'cards',
        attemptNumber: 1,
        provider: 'openai-compatible',
        model: 'stub-model',
        promptId: 'cards/generate.v1',
        promptVersion: '1',
        promptHash: 'hash-not-used-by-this-test',
        status: 'succeeded',
        inputTokens: 90_000,
        outputTokens: 4_000,
        temperature: 0.2,
        maxOutputTokens: 8_000,
        timeoutMs: 90_000,
      });

      const held = reserveBudget(db, {
        userId: adminId,
        jobId: null,
        attemptId: 'pat_overspend_incident',
        amountMinor: 5,
        currency: 'USD',
        periodKey,
        model: 'stub-model',
      });
      if (!held.ok) throw new Error('The test hold was refused.');

      // The provider reports more usage than the request ceiling anticipated.
      settleReservation(db, {
        reservationId: held.reservationId,
        outcome: 'charged',
        amountMinor: 9,
        inputTokens: 90_000,
        outputTokens: 4_000,
        source: 'provider_reported',
        priceVersion: 'prices-v2+env+unknown-model+model:stub-model',
        currency: 'USD',
        providerAttemptId: attemptRowId,
        model: 'stub-model',
      });

      // The figure is counted in full — the cap already reflects it — and the estimation defect
      // is named rather than left to be rediscovered next month.
      expect(readUsageTotals(db, periodKey, adminId).chargedMinor).toBeGreaterThanOrEqual(9);

      const report = await admin.call('/api/admin/budget');
      const incident = report.body.budget.incidents.find(
        (row: any) => row.userId === adminId && row.overMinor === 4
      );

      expect(incident).toBeDefined();
      expect(incident.reservedMinor).toBe(5);
      expect(incident.chargedMinor).toBe(9);
      expect(incident.model).toBe('stub-model');
      expect(incident.detail).toContain('more than was reserved');

      // The attempt row records the timeout it was dispatched under (F-N), so a run describes
      // itself rather than the current environment.
      const attempt = db
        .query('SELECT timeout_ms FROM provider_attempts WHERE id = ?')
        .get(attemptRowId) as { timeout_ms: number | null };
      expect(attempt.timeout_ms).toBe(90_000);
    } finally {
      clearChargesFor(adminId);
      db.prepare('DELETE FROM provider_attempts WHERE attempt_id = ?').run(
        'pat_overspend_incident'
      );
    }
  });
});

describe('Reconciling a charge', () => {
  it('records the figure the invoice shows, and attributes the decision', async () => {
    try {
      const reservationId = uncertainHold({
        userId: adminId,
        attemptId: 'pat_reconcile_charged',
        amountMinor: 300,
      });
      expect(readUsageTotals(db, periodKey, adminId).reconcilingMinor).toBe(300);

      const response = await admin.call(
        `/api/admin/budget/uncertain/${reservationId}/reconcile`,
        {
          method: 'POST',
          body: { outcome: 'charged', amountMinor: 137, note: 'invoice 2026-09 line 4' },
        }
      );

      expect(response.status).toBe(200);
      expect(response.body.reconciled).toEqual({
        reservationId,
        outcome: 'charged',
        amountMinor: 137,
      });

      // The invoice figure replaces the estimate: the hold is gone, and what is counted is 137
      // rather than the 300 that was assumed while the outcome was unknown.
      const totals = readUsageTotals(db, periodKey, adminId);
      expect(totals.reconcilingMinor).toBe(0);
      expect(totals.chargedMinor).toBe(137);

      // The ledger's own total is the invoice figure too: the 300 estimate was reversed and the
      // 137 that was established recorded in its place, so nothing still claims the old guess.
      const rows = ledgerRowsFor(adminId);
      expect(rows).toHaveLength(3);
      expect(rows[0].amount_minor).toBe(300);
      expect(rows[0].source).toBe('estimated');
      expect(rows[1].amount_minor).toBe(-300);
      expect(rows[2].amount_minor).toBe(137);
      expect(ledgerTotalFor(adminId)).toBe(137);

      // Money moved because somebody decided it should, and the record says who and why.
      const audit = readReconciliationAudit(db, reservationId);
      expect(audit?.reconciledBy).toBe(adminId);
      expect(audit?.note).toBe('invoice 2026-09 line 4');
      expect(audit?.reconciledAt).not.toBeNull();

      // The screen shows the position enforcement now holds.
      expect(response.body.budget.reconcilingMinor).toBe(
        readUsageTotals(db, periodKey).reconcilingMinor
      );
    } finally {
      clearChargesFor(adminId);
    }
  });

  it('records "nothing was billed" as a decision rather than as a refund', async () => {
    try {
      const reservationId = uncertainHold({
        userId: adminId,
        attemptId: 'pat_reconcile_released',
        amountMinor: 250,
      });

      // The hold recorded the estimate nobody could verify, labelled as an estimate.
      expect(ledgerRowsFor(adminId)).toHaveLength(1);
      expect(ledgerRowsFor(adminId)[0].amount_minor).toBe(250);
      expect(ledgerRowsFor(adminId)[0].source).toBe('estimated');

      const released = await admin.call(
        `/api/admin/budget/uncertain/${reservationId}/reconcile`,
        { method: 'POST', body: { outcome: 'released' } }
      );
      expect(released.status).toBe(200);
      expect(released.body.reconciled.amountMinor).toBe(0);

      // Released means nothing was billed. The estimate is superseded by a correction rather than
      // deleted, because the ledger is append-only — and what matters is that its own total is now
      // zero, so the ledger stops claiming money that was never spent.
      const rows = ledgerRowsFor(adminId);
      expect(rows).toHaveLength(2);
      expect(rows[1].amount_minor).toBe(-250);
      expect(rows[1].source).toBe('provider_reported');
      expect(ledgerTotalFor(adminId)).toBe(0);

      const totals = readUsageTotals(db, periodKey, adminId);
      expect(totals.reconcilingMinor).toBe(0);
      expect(totals.committedMinor).toBe(0);

      // The decision is attributed here too.
      expect(readReconciliationAudit(db, reservationId)?.reconciledBy).toBe(adminId);
    } finally {
      clearChargesFor(adminId);
    }
  });

  it('refuses to settle the same charge twice, and refuses an unknown one', async () => {
    try {
      const reservationId = uncertainHold({
        userId: adminId,
        attemptId: 'pat_reconcile_twice',
        amountMinor: 90,
      });

      const first = await admin.call(`/api/admin/budget/uncertain/${reservationId}/reconcile`, {
        method: 'POST',
        body: { outcome: 'charged', amountMinor: 42 },
      });
      expect(first.status).toBe(200);

      // Settling it again would misstate the ledger, so the second attempt is refused and the
      // first decision is what stands.
      const again = await admin.call(`/api/admin/budget/uncertain/${reservationId}/reconcile`, {
        method: 'POST',
        body: { outcome: 'released' },
      });
      expect(again.status).toBe(409);
      expect(again.body.error.code).toBe('not_reconciling');
      expect(readUsageTotals(db, periodKey, adminId).chargedMinor).toBe(42);

      const unknown = await admin.call(
        '/api/admin/budget/uncertain/rsv_does_not_exist/reconcile',
        { method: 'POST', body: { outcome: 'released' } }
      );
      expect(unknown.status).toBe(404);
      expect(unknown.body.error.code).toBe('reservation_not_found');
    } finally {
      clearChargesFor(adminId);
    }
  });

  it('will not invent a figure, and will not accept a decision it does not understand', async () => {
    try {
      const reservationId = uncertainHold({
        userId: adminId,
        attemptId: 'pat_reconcile_invalid',
        amountMinor: 60,
      });
      const path = `/api/admin/budget/uncertain/${reservationId}/reconcile`;

      const noAmount = await admin.call(path, { method: 'POST', body: { outcome: 'charged' } });
      expect(noAmount.status).toBe(400);
      expect(noAmount.body.error.code).toBe('field_required');

      const negative = await admin.call(path, {
        method: 'POST',
        body: { outcome: 'charged', amountMinor: -5 },
      });
      expect(negative.status).toBe(400);

      const badOutcome = await admin.call(path, {
        method: 'POST',
        body: { outcome: 'refunded' },
      });
      expect(badOutcome.status).toBe(400);
      expect(badOutcome.body.error.code).toBe('field_invalid');

      // None of those attempts settled anything, so the hold is still waiting for a decision.
      expect(readUsageTotals(db, periodKey, adminId).reconcilingMinor).toBe(60);
    } finally {
      clearChargesFor(adminId);
    }
  });
});

describe('Resolving money is an administrator operation', () => {
  it('refuses an anonymous caller and an ordinary account', async () => {
    try {
      const reservationId = uncertainHold({
        userId: memberId,
        attemptId: 'pat_reconcile_permissions',
        amountMinor: 75,
      });
      const path = `/api/admin/budget/uncertain/${reservationId}/reconcile`;

      // A hidden button is not authorization: both callers are refused by the route itself.
      const anonymous = new Client(base);
      const anonymousAttempt = await anonymous.call(path, {
        method: 'POST',
        body: { outcome: 'released' },
      });
      expect(anonymousAttempt.status).toBe(401);

      const memberAttempt = await member.call(path, {
        method: 'POST',
        body: { outcome: 'released' },
      });
      expect(memberAttempt.status).toBe(403);
      expect(memberAttempt.body.error.code).toBe('admin_required');

      // The member cannot read the installation's accounting either.
      expect((await member.call('/api/admin/budget')).status).toBe(403);

      // Nothing above changed the hold.
      expect(readUsageTotals(db, periodKey, memberId).reconcilingMinor).toBe(75);
      const stillListed = await admin.call('/api/admin/budget');
      expect(
        stillListed.body.budget.uncertain.some(
          (row: any) => row.reservationId === reservationId
        )
      ).toBe(true);
    } finally {
      clearChargesFor(memberId);
    }
  });
});
