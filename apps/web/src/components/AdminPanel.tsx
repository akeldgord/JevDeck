import React, { useState } from 'react';
import { SystemUsageStats } from '@jevdeck/contracts';
import { Capability } from '../config/capabilities';
import { UnavailablePanel } from './UnavailablePanel';
import { SimulatedBadge } from './DemoBanner';
import {
  Shield,
  Users,
  Mail,
  Copy,
  Trash2,
  Sliders,
  Activity,
  Send,
  Loader2,
  AlertCircle,
  UserMinus,
  UserCheck,
} from 'lucide-react';

/** View type for the roster. Mirrors what the API returns, not the storage schema. */
export interface AdminUserRow {
  id: string;
  name: string;
  email: string;
  role: 'admin' | 'member';
  status: 'active' | 'disabled';
  monthlySpendLimitUsd: number;
}

export interface AdminInvitationRow {
  id: string;
  email: string;
  role: 'admin' | 'member';
  monthlySpendLimitUsd: number;
  expiresAt: string;
  status: 'pending' | 'accepted' | 'revoked';
}

interface Props {
  users: AdminUserRow[];
  invitations: AdminInvitationRow[];
  /**
   * Usage figures read from the ledger, or `null` when they could not be read.
   *
   * `null` hides the budget section rather than filling it with invented numbers: every figure
   * shown comes from a stored row, and an absent one is reported as absent.
   */
  stats: SystemUsageStats | null;
  onInviteUser: (email: string, monthlySpendLimitUsd: number) => Promise<void>;
  onRevokeInvitation: (id: string) => Promise<void>;
  onUpdateInstanceCap: (newCapUsd: number) => void;
  onSetUserStatus: (userId: string, status: 'active' | 'disabled') => Promise<void>;
  /** Whether the accounts and invitations below are real. */
  capability: Capability;
  isDemo: boolean;
  /** The signed-in account, so it cannot disable itself. */
  currentUserId: string | null;
  /** Invitation link returned by the most recent successful issuance. Shown once. */
  inviteUrl: string | null;
  busy: boolean;
}

export const AdminPanel: React.FC<Props> = ({
  users,
  invitations,
  stats,
  onInviteUser,
  onRevokeInvitation,
  onUpdateInstanceCap,
  onSetUserStatus,
  capability,
  isDemo,
  currentUserId,
  inviteUrl,
  busy,
}) => {
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteLimit, setInviteLimit] = useState(25);
  const [instanceCapInput, setInstanceCapInput] = useState(stats?.instanceMonthlyCapUsd ?? 0);
  const [isEditingCap, setIsEditingCap] = useState(false);

  // Requirement (R0): never render invitation creation, an account roster or spending
  // figures without the corresponding real operation.
  if (!capability.available) {
    return (
      <div className="max-w-3xl mx-auto space-y-6">
        <UnavailablePanel
          capability={capability}
          blockedAction="This screen is read-only: no invitation can be issued, no account exists and no limit is enforced."
        />
        <div className="bg-slate-900/60 border border-slate-800 rounded-3xl p-6 sm:p-8 space-y-3">
          <h2 className="text-base font-bold text-slate-100">How accounts work</h2>
          <ul className="text-xs text-slate-400 space-y-2 list-disc list-inside leading-relaxed">
            <li>There is no public registration endpoint — and none will be added.</li>
            <li>Accounts are created only by administrator invitation, with single-use, expiring, revocable tokens.</li>
            <li>Provider credentials are held server-side; they are not readable from this page.</li>
            <li>Per-user and installation spending limits will be enforced server-side against a usage ledger.</li>
          </ul>
        </div>
      </div>
    );
  }

  const handleSendInvite = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!inviteEmail.trim()) return;
    await onInviteUser(inviteEmail.trim(), inviteLimit);
    setInviteEmail('');
  };

  const percentUsed =
    stats && stats.instanceMonthlyCapUsd > 0
      ? Math.min(100, Math.round((stats.instanceTotalSpendUsd / stats.instanceMonthlyCapUsd) * 100))
      : 0;

  const pendingInvitations = invitations.filter(invitation => invitation.status === 'pending');

  return (
    <div className="space-y-8 max-w-6xl mx-auto">
      {/* Budget controls — only when something actually tracks spending */}
      {stats ? (
        <div className="bg-slate-900/60 border border-slate-800 rounded-3xl p-6 sm:p-8 backdrop-blur-md shadow-xl space-y-6">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div>
              <div className="flex items-center gap-2">
                <Shield className="w-5 h-5 text-emerald-400" />
                <h2 className="text-xl font-bold text-slate-100 flex items-center gap-2">
                  Instance Governance & Shared API Budget
                  {isDemo && <SimulatedBadge label="Demo data" />}
                </h2>
              </div>
              <p className="text-xs text-slate-400 mt-1">
                {isDemo
                  ? 'Synthetic usage figures. No provider call produced them, and no limit below is enforced.'
                  : 'Administrator-managed limits. Enforcement is server-side.'}
              </p>
            </div>

            <div className="flex items-center gap-3">
              {isEditingCap ? (
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    value={instanceCapInput}
                    onChange={event => setInstanceCapInput(Number(event.target.value))}
                    aria-label="Instance monthly spend cap"
                    className="w-24 px-3 py-1.5 rounded-lg bg-slate-950 border border-slate-700 text-sm font-mono text-emerald-400"
                  />
                  <button
                    onClick={() => {
                      onUpdateInstanceCap(instanceCapInput);
                      setIsEditingCap(false);
                    }}
                    className="px-3 py-1.5 rounded-lg bg-emerald-500 text-slate-950 font-bold text-xs"
                  >
                    Save
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setIsEditingCap(true)}
                  className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-slate-300 transition-colors flex items-center gap-1.5"
                >
                  <Sliders className="w-3.5 h-3.5" />
                  <span>Adjust Instance Cap (${stats.instanceMonthlyCapUsd})</span>
                </button>
              )}
            </div>
          </div>

          <div className="space-y-2 bg-slate-950/60 p-4 rounded-2xl border border-slate-800/80">
            <div className="flex justify-between text-xs font-medium">
              <span className="text-slate-400">Total Instance Spend (This Month)</span>
              <span className="font-mono text-slate-200">
                <span className="text-emerald-400 font-bold">
                  ${stats.instanceTotalSpendUsd.toFixed(2)}
                </span>{' '}
                / ${stats.instanceMonthlyCapUsd.toFixed(2)} USD ({percentUsed}%)
              </span>
            </div>
            <div className="w-full h-3 bg-slate-800 rounded-full overflow-hidden">
              <div
                className={`h-full transition-all duration-500 ${
                  percentUsed > 80 ? 'bg-amber-500' : 'bg-gradient-to-r from-emerald-500 to-teal-400'
                }`}
                style={{ width: `${percentUsed}%` }}
              />
            </div>
            <div className="flex justify-between text-[11px] font-mono text-slate-500 pt-1">
              <span>
                {stats.instanceMonthlyTokenCap > 0
                  ? `Tokens consumed: ${stats.instanceTotalTokens.toLocaleString()} / ${stats.instanceMonthlyTokenCap.toLocaleString()}`
                  : `Tokens consumed this period: ${stats.instanceTotalTokens.toLocaleString()} (no token cap configured)`}
              </span>
              <span>{isDemo ? 'Synthetic users' : 'Active Users'}: {users.length}</span>
            </div>
          </div>
        </div>
      ) : (
        <div className="rounded-2xl border border-slate-800 bg-slate-900/40 p-5 space-y-2">
          <div className="flex items-center gap-2">
            <Activity className="w-4 h-4 text-slate-500" />
            <h2 className="text-sm font-bold text-slate-300">Instance spending</h2>
          </div>
          <p className="text-xs text-slate-400 leading-relaxed">
            No usage ledger exists yet, so there are no spend or token figures to show and none
            are invented. Provider calls, reservations and reconciliation arrive with the
            usage-accounting workstream.
          </p>
        </div>
      )}

      {/* Invitations */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <div className="lg:col-span-5 bg-slate-900/60 border border-slate-800 rounded-3xl p-6 shadow-xl space-y-4">
          <div className="flex items-center gap-2">
            <Mail className="w-4 h-4 text-emerald-400" />
            <h3 className="text-base font-bold text-slate-100">Issue an invitation</h3>
          </div>
          <p className="text-xs text-slate-400">
            Registration is invitation-only. The link is shown once and stored only as a hash;
            it expires, can be revoked, and can be used a single time.
          </p>

          <form onSubmit={handleSendInvite} className="space-y-4 pt-2">
            <div>
              <label className="block text-xs font-semibold text-slate-400 mb-1">
                Colleague / student email
              </label>
              <input
                type="email"
                required
                placeholder="colleague@institution.edu"
                value={inviteEmail}
                onChange={event => setInviteEmail(event.target.value)}
                className="w-full px-3.5 py-2.5 rounded-xl bg-slate-950 border border-slate-800 text-sm text-slate-100 placeholder-slate-600 focus:outline-none focus:border-emerald-500 transition-colors"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-400 mb-1">
                Monthly spend cap (USD)
              </label>
              <input
                type="number"
                min={0}
                value={inviteLimit}
                onChange={event => setInviteLimit(Number(event.target.value))}
                className="w-full px-3.5 py-2.5 rounded-xl bg-slate-950 border border-slate-800 text-sm font-mono text-emerald-400 focus:outline-none focus:border-emerald-500"
              />
              <p className="text-[10px] text-slate-500 mt-1">
                Recorded on the account. Spending is not enforced yet — no ledger exists.
              </p>
            </div>

            <button
              type="submit"
              disabled={busy}
              className="w-full py-3 rounded-xl bg-emerald-500 hover:bg-emerald-400 disabled:bg-slate-800 disabled:text-slate-500 text-slate-950 font-bold text-sm transition-all flex items-center justify-center gap-2 shadow-lg shadow-emerald-500/20"
            >
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
              <span>Create invitation link</span>
            </button>
          </form>

          {inviteUrl && (
            <div className="rounded-xl border border-emerald-900/50 bg-emerald-950/20 p-3 space-y-2">
              <p className="text-[11px] font-semibold text-emerald-300">
                Invitation link (shown once — it is stored hashed)
              </p>
              <code className="block text-[10px] font-mono text-emerald-200/90 break-all bg-slate-950/60 rounded p-2">
                {inviteUrl}
              </code>
              <button
                onClick={() => navigator.clipboard.writeText(inviteUrl)}
                className="text-[11px] px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 font-medium flex items-center gap-1.5"
              >
                <Copy className="w-3 h-3" />
                Copy link
              </button>
            </div>
          )}
        </div>

        <div className="lg:col-span-7 bg-slate-900/60 border border-slate-800 rounded-3xl p-6 shadow-xl space-y-4">
          <h3 className="text-base font-bold text-slate-100 flex items-center gap-2">
            <Users className="w-4 h-4 text-cyan-400" />
            Pending invitations ({pendingInvitations.length})
          </h3>

          <div className="divide-y divide-slate-800/80 max-h-[360px] overflow-y-auto">
            {invitations.length === 0 ? (
              <div className="text-center py-8 text-xs text-slate-500">
                No invitations have been issued.
              </div>
            ) : (
              invitations.map(invitation => (
                <div key={invitation.id} className="py-3 flex items-center justify-between gap-4">
                  <div className="space-y-0.5 min-w-0">
                    <div className="text-sm font-semibold text-slate-200 truncate">
                      {invitation.email}
                    </div>
                    <div className="text-xs font-mono text-slate-500 flex items-center gap-2 flex-wrap">
                      <span
                        className={
                          invitation.status === 'pending'
                            ? 'text-emerald-400'
                            : invitation.status === 'accepted'
                              ? 'text-cyan-400'
                              : 'text-amber-400'
                        }
                      >
                        {invitation.status}
                      </span>
                      <span>•</span>
                      <span>Limit: ${invitation.monthlySpendLimitUsd}/mo</span>
                      {invitation.status === 'pending' && (
                        <>
                          <span>•</span>
                          <span>{describeExpiry(invitation.expiresAt)}</span>
                        </>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-2 flex-shrink-0">
                    {invitation.status === 'pending' && (
                      <button
                        onClick={() => onRevokeInvitation(invitation.id)}
                        disabled={busy}
                        className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-300 text-xs font-medium flex items-center gap-1.5 transition-colors"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        <span>Revoke</span>
                      </button>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Roster */}
      <div className="bg-slate-900/60 border border-slate-800 rounded-3xl p-6 sm:p-8 shadow-xl space-y-4">
        <h3 className="text-base font-bold text-slate-100 flex items-center gap-2">
          <Activity className="w-4 h-4 text-emerald-400" />
          Accounts ({users.length})
        </h3>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs sm:text-sm">
            <thead>
              <tr className="border-b border-slate-800 text-slate-400 text-xs uppercase tracking-wider font-semibold">
                <th className="pb-3">User</th>
                <th className="pb-3">Role</th>
                <th className="pb-3">Spend cap</th>
                <th className="pb-3">Spend</th>
                <th className="pb-3">Status</th>
                <th className="pb-3 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60 font-mono text-xs">
              {users.map(user => (
                <tr key={user.id} className="hover:bg-slate-800/30 transition-colors">
                  <td className="py-3.5 font-sans font-medium text-slate-200">
                    <div>{user.name}</div>
                    <div className="text-xs text-slate-500 font-normal">{user.email}</div>
                  </td>
                  <td className="py-3.5">
                    <span
                      className={`px-2 py-0.5 rounded text-[10px] font-sans font-bold uppercase ${
                        user.role === 'admin'
                          ? 'bg-emerald-950 text-emerald-400 border border-emerald-800/60'
                          : 'bg-slate-800 text-slate-400'
                      }`}
                    >
                      {user.role}
                    </span>
                  </td>
                  <td className="py-3.5 text-slate-300">
                    ${user.monthlySpendLimitUsd.toFixed(2)}
                  </td>
                  <td className="py-3.5 text-slate-500" title="No usage ledger exists yet">
                    not tracked
                  </td>
                  <td className="py-3.5 font-sans">
                    <span
                      className={`text-xs font-semibold flex items-center gap-1 ${
                        user.status === 'active' ? 'text-emerald-400' : 'text-amber-400'
                      }`}
                    >
                      ● {user.status}
                    </span>
                  </td>
                  <td className="py-3.5 text-right">
                    {user.id === currentUserId ? (
                      <span className="text-[10px] text-slate-500 font-sans">this account</span>
                    ) : (
                      <button
                        onClick={() =>
                          onSetUserStatus(user.id, user.status === 'active' ? 'disabled' : 'active')
                        }
                        disabled={busy}
                        className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-300 text-xs font-medium inline-flex items-center gap-1.5 transition-colors"
                      >
                        {user.status === 'active' ? (
                          <>
                            <UserMinus className="w-3.5 h-3.5" />
                            <span>Disable</span>
                          </>
                        ) : (
                          <>
                            <UserCheck className="w-3.5 h-3.5" />
                            <span>Enable</span>
                          </>
                        )}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="flex items-start gap-2 text-[11px] text-slate-500 pt-1">
          <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
          <span>
            Disabling an account revokes its active sessions immediately, so access stops on the
            next request rather than when a cookie happens to expire.
          </span>
        </div>
      </div>
    </div>
  );
};

function describeExpiry(expiresAt: string): string {
  const remainingMs = Date.parse(expiresAt) - Date.now();
  if (!Number.isFinite(remainingMs)) return 'expiry unknown';
  if (remainingMs <= 0) return 'expired';

  const hours = Math.floor(remainingMs / 3_600_000);
  if (hours < 1) return 'expires in under an hour';
  if (hours < 48) return `expires in ${hours} hour${hours === 1 ? '' : 's'}`;

  const days = Math.round(hours / 24);
  return `expires in ${days} days`;
}
