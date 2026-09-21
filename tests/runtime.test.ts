import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  COVERAGE_CHOICES,
  resolveCapabilities,
  resolveRuntimeEnvironment,
} from '../apps/web/src/config/capabilities';
import { DEMO_MODE_NOTICE, loadDemoWorkspace } from '../apps/web/src/demo/demoWorkspace';

const read = (relativePath: string) =>
  readFileSync(new URL(relativePath, import.meta.url), 'utf8');

describe('The shipped image is built on the toolchain that was tested', () => {
  it('pins the Dockerfile to `.bun-version` instead of floating within a major', () => {
    // The lockfile and the SQLite binding are version-sensitive, so the image and the tests that
    // check it have to come from one version of Bun. This is the assertion that keeps somebody from
    // bumping one of the two files and leaving the other behind: a floating `oven/bun:1-alpine`
    // would build cleanly and ship a runtime nobody tested.
    const pinned = read('../.bun-version').trim();
    const dockerfile = read('../Dockerfile');

    expect(pinned.length).toBeGreaterThan(0);
    expect(dockerfile).toContain(`ARG BUN_VERSION=${pinned}`);
    expect(dockerfile).toContain('FROM oven/bun:${BUN_VERSION}-alpine AS build');
    expect(dockerfile).toContain('FROM oven/bun:${BUN_VERSION}-alpine AS runtime');
    expect(dockerfile).not.toContain('oven/bun:1-alpine');
  });
});

describe('The web build works from a clean checkout, the way the image builds it', () => {
  it('typechecks its project references rather than reusing outputs the image never has', () => {
    // `.dockerignore` excludes `**/dist` and `**/*.tsbuildinfo`, so the image's build stage begins
    // with no declarations at all. `apps/web` is a `noEmit` project whose imports resolve through
    // project references into `packages/*/dist`, and plain `tsc` does not build references: every
    // cross-package import reported TS6305 and then collapsed into a cascade of implicit-anys and
    // type mismatches, so `docker build` failed while a local `bun run build` passed on declarations
    // an earlier `tsc -b` had left behind. Build mode is what makes the two agree.
    const web = JSON.parse(read('../apps/web/package.json')) as {
      scripts: Record<string, string>;
    };

    const build = web.scripts.build;
    expect(build).toContain('tsc -b');
    expect(build).not.toMatch(/\btsc\s+&&/);
  });

  it('does not leave a workspace build script depending on another workspace\'s output', () => {
    // The same defect in any other workspace would be just as invisible locally, so the rule is
    // stated once for the whole tree rather than only for the workspace that happened to break.
    const workspaces = [
      '../apps/web/package.json',
      '../apps/api/package.json',
      '../apps/worker/package.json',
      ...['contracts', 'generation', 'ingestion', 'scheduling', 'validation', 'anki_export'].map(
        name => `../packages/${name}/package.json`
      ),
    ];

    const builds = workspaces
      .map(workspace => {
        const parsed = JSON.parse(read(workspace)) as { scripts?: Record<string, string> };
        return { workspace, build: parsed.scripts?.build };
      })
      .filter((entry): entry is { workspace: string; build: string } => Boolean(entry.build));

    // Without this the rule could pass by applying to nothing at all.
    expect(builds.length).toBeGreaterThan(0);

    for (const { workspace, build } of builds) {
      expect(`${workspace}: ${build}`).not.toMatch(/(^|[^\w-])tsc\s+&&/);
    }
  });
});

describe('Runtime environment resolution', () => {
  it('is off unless the demo flag is exactly "true"', () => {
    for (const flag of [undefined, '', 'false', '0', '1', 'yes', 'TRUE', 'True', 'demo']) {
      expect(resolveRuntimeEnvironment(flag).demoMode).toBe(false);
    }
    expect(resolveRuntimeEnvironment('true').demoMode).toBe(true);
  });
});

describe('Capabilities in production (no demo flag)', () => {
  const capabilities = resolveCapabilities({ demoMode: false });

  it('reports generation as unavailable with an actionable explanation', () => {
    // Acceptance (R0): normal operation without configured credentials reports that
    // generation is unavailable and returns no fabricated cards.
    expect(capabilities.generation.available).toBe(false);
    if (!capabilities.generation.available) {
      expect(capabilities.generation.title.length).toBeGreaterThan(0);
      expect(capabilities.generation.detail.length).toBeGreaterThan(0);
      expect(capabilities.generation.remedy.length).toBeGreaterThan(0);
    }
  });

  it('reports administration, storage and session as unavailable', () => {
    expect(capabilities.administration.available).toBe(false);
    expect(capabilities.durableStorage.available).toBe(false);
    expect(capabilities.session.available).toBe(false);
  });

  it('exposes no field that could supply a synthetic user, document or card', () => {
    expect(Object.keys(capabilities).sort()).toEqual([
      'administration',
      'durableStorage',
      'generation',
      'session',
    ]);
  });
});

describe('Capabilities in demo mode', () => {
  const capabilities = resolveCapabilities({ demoMode: true });

  it('is available only as an explicitly labelled simulation', () => {
    for (const capability of [
      capabilities.generation,
      capabilities.administration,
      capabilities.durableStorage,
      capabilities.session,
    ]) {
      expect(capability.available).toBe(true);
      if (capability.available) {
        expect(capability.simulated).toBe(true);
      }
    }
  });
});

describe('Coverage choices', () => {
  it('offers exactly the two agreed modes', () => {
    expect(COVERAGE_CHOICES.length).toBe(2);
    expect(COVERAGE_CHOICES.map(c => c.value)).toEqual(['high-yield', 'comprehensive']);
  });

  it('promises no card count, duration or cost', () => {
    const copy = COVERAGE_CHOICES.map(c => `${c.label} ${c.description}`).join(' ').toLowerCase();
    expect(copy).not.toMatch(/[0-9]/);
    expect(copy).not.toContain('card');
    expect(copy).not.toContain('minute');
    expect(copy).not.toContain('cost');
  });
});

describe('Generation screen displays no workload estimate', () => {
  const view = read('../apps/web/src/components/GenerationView.tsx');

  it('references none of the removed estimator identifiers', () => {
    for (const identifier of [
      'estimateWorkload',
      'WorkloadEstimate',
      'estimatedCards',
      'estimatedStudyTimeMinutes',
      'estimatedCostUsd',
      'estimatedTokens',
    ]) {
      expect(view).not.toContain(identifier);
    }
  });

  it('renders coverage choices from the single shared list', () => {
    expect(view).toContain('COVERAGE_CHOICES');
  });
});

describe('Demo workspace', () => {
  const workspace = loadDemoWorkspace();

  it('carries an explicit demo notice', () => {
    expect(workspace.notice).toBe(DEMO_MODE_NOTICE);
    expect(workspace.notice.toLowerCase()).toContain('demo mode');
  });

  it('grounds its starter cards in the fixture document text', () => {
    expect(workspace.cards.length).toBeGreaterThan(0);
    for (const card of workspace.cards) {
      const page = workspace.pages.find(p => p.pageNumber === card.grounding.pageNumber);
      expect(page).toBeDefined();
      expect(page!.text.includes(card.grounding.excerpt)).toBe(true);
    }
  });

  it('uses non-routable example.invalid identities, not plausible people', () => {
    expect(workspace.users.length).toBeGreaterThan(0);
    for (const user of workspace.users) {
      expect(user.email.endsWith('.invalid')).toBe(true);
    }
  });
});

describe('Production cannot fall back to demo content', () => {
  const app = read('../apps/web/src/App.tsx');

  it('loads the demo workspace only behind the demo flag', () => {
    expect(app).toContain('isDemoMode ? loadDemoWorkspace() : null');
  });

  it('never selects a sample identity, deck or usage record', () => {
    // Acceptance (R0): production startup never selects INITIAL_USERS[0] as the
    // authenticated user. The synthetic records no longer exist outside the demo module.
    for (const symbol of ['INITIAL_USERS', 'INITIAL_CARDS', 'INITIAL_STATS', 'INITIAL_SECTIONS', 'INITIAL_INVITATIONS', 'SAMPLE_DECK']) {
      expect(app).not.toContain(symbol);
    }
  });

  it('keeps the simulated usage helper inside the demo module', () => {
    const usage = read('../apps/web/src/demo/simulatedUsage.ts');
    expect(usage.toLowerCase()).toContain('demo only');
    expect(app).toContain('capabilities.generation.simulated');
  });
});
