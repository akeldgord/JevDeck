import React, { useState } from 'react';
import { User, Invitation, SystemUsageStats } from '@jevdeck/contracts';
import { 
  Shield, 
  Users, 
  Mail, 
  Copy, 
  Check, 
  Trash2, 
  Sliders, 
  Activity,
  Send
} from 'lucide-react';

interface Props {
  users: User[];
  invitations: Invitation[];
  stats: SystemUsageStats;
  onInviteUser: (email: string, spendLimit: number) => void;
  onRevokeInvitation: (id: string) => void;
  onUpdateInstanceCap: (newCapUsd: number) => void;
}

export const AdminPanel: React.FC<Props> = ({
  users,
  invitations,
  stats,
  onInviteUser,
  onRevokeInvitation,
  onUpdateInstanceCap,
}) => {
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteLimit, setInviteLimit] = useState(25);
  const [copiedToken, setCopiedToken] = useState<string | null>(null);
  const [instanceCapInput, setInstanceCapInput] = useState(stats.instanceMonthlyCapUsd);
  const [isEditingCap, setIsEditingCap] = useState(false);

  const handleSendInvite = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inviteEmail.trim()) return;
    onInviteUser(inviteEmail.trim(), inviteLimit);
    setInviteEmail('');
  };

  const copyInviteLink = (token: string) => {
    navigator.clipboard.writeText(`https://jevdeck.local/join?token=${token}`);
    setCopiedToken(token);
    setTimeout(() => setCopiedToken(null), 2000);
  };

  const percentUsed = Math.min(100, Math.round((stats.instanceTotalSpendUsd / stats.instanceMonthlyCapUsd) * 100));

  return (
    <div className="space-y-8 max-w-6xl mx-auto">
      {/* Overview & Spending Limit Controls */}
      <div className="bg-slate-900/60 border border-slate-800 rounded-3xl p-6 sm:p-8 backdrop-blur-md shadow-xl space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <Shield className="w-5 h-5 text-emerald-400" />
              <h2 className="text-xl font-bold text-slate-100">
                Instance Governance & Shared API Budget
              </h2>
            </div>
            <p className="text-xs text-slate-400 mt-1">
              Confirmed requirement: Self-hosted administrator invitation management and usage tracking with configurable user and instance limits.
            </p>
          </div>

          <div className="flex items-center gap-3">
            {isEditingCap ? (
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  value={instanceCapInput}
                  onChange={(e) => setInstanceCapInput(Number(e.target.value))}
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

        {/* Global Progress Gauge */}
        <div className="space-y-2 bg-slate-950/60 p-4 rounded-2xl border border-slate-800/80">
          <div className="flex justify-between text-xs font-medium">
            <span className="text-slate-400">Total Instance Spend (This Month)</span>
            <span className="font-mono text-slate-200">
              <span className="text-emerald-400 font-bold">${stats.instanceTotalSpendUsd.toFixed(2)}</span> / ${stats.instanceMonthlyCapUsd.toFixed(2)} USD ({percentUsed}%)
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
            <span>Tokens Consumed: {stats.instanceTotalTokens.toLocaleString()} / {stats.instanceMonthlyTokenCap.toLocaleString()}</span>
            <span>Active Users: {users.length}</span>
          </div>
        </div>
      </div>

      {/* Invitations Section */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left: Issue Invitation Form */}
        <div className="lg:col-span-5 bg-slate-900/60 border border-slate-800 rounded-3xl p-6 shadow-xl space-y-4">
          <div className="flex items-center gap-2">
            <Mail className="w-4 h-4 text-emerald-400" />
            <h3 className="text-base font-bold text-slate-100">Issue Admin Invitation</h3>
          </div>
          <p className="text-xs text-slate-400">
            Account registration is locked to invitations only to prevent unauthorized API billing.
          </p>

          <form onSubmit={handleSendInvite} className="space-y-4 pt-2">
            <div>
              <label className="block text-xs font-semibold text-slate-400 mb-1">
                Colleague / Student Email
              </label>
              <input
                type="email"
                required
                placeholder="colleague@institution.edu"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                className="w-full px-3.5 py-2.5 rounded-xl bg-slate-950 border border-slate-800 text-sm text-slate-100 placeholder-slate-600 focus:outline-none focus:border-emerald-500 transition-colors"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-400 mb-1">
                Monthly Spend Cap for User ($ USD)
              </label>
              <input
                type="number"
                min={1}
                max={stats.instanceMonthlyCapUsd}
                value={inviteLimit}
                onChange={(e) => setInviteLimit(Number(e.target.value))}
                className="w-full px-3.5 py-2.5 rounded-xl bg-slate-950 border border-slate-800 text-sm font-mono text-emerald-400 focus:outline-none focus:border-emerald-500"
              />
            </div>

            <button
              type="submit"
              className="w-full py-3 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-sm transition-all flex items-center justify-center gap-2 shadow-lg shadow-emerald-500/20 active:scale-[0.98]"
            >
              <Send className="w-4 h-4" />
              <span>Generate Invitation Token</span>
            </button>
          </form>
        </div>

        {/* Right: Pending Invitations */}
        <div className="lg:col-span-7 bg-slate-900/60 border border-slate-800 rounded-3xl p-6 shadow-xl space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-base font-bold text-slate-100 flex items-center gap-2">
              <Users className="w-4 h-4 text-cyan-400" />
              Pending Invitations ({invitations.length})
            </h3>
          </div>

          <div className="divide-y divide-slate-800/80 max-h-[340px] overflow-y-auto">
            {invitations.length === 0 ? (
              <div className="text-center py-8 text-xs text-slate-500">
                No active pending invitations.
              </div>
            ) : (
              invitations.map((inv) => (
                <div key={inv.id} className="py-3 flex items-center justify-between gap-4">
                  <div className="space-y-0.5">
                    <div className="text-sm font-semibold text-slate-200">{inv.email}</div>
                    <div className="text-xs font-mono text-slate-500 flex items-center gap-2">
                      <span>Limit: ${inv.monthlySpendLimitUsd}/mo</span>
                      <span>•</span>
                      <span>Expires in 7 days</span>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => copyInviteLink(inv.token)}
                      className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium flex items-center gap-1.5 transition-colors"
                      title="Copy Invite URL"
                    >
                      {copiedToken === inv.token ? (
                        <>
                          <Check className="w-3.5 h-3.5 text-emerald-400" />
                          <span className="text-emerald-400">Copied</span>
                        </>
                      ) : (
                        <>
                          <Copy className="w-3.5 h-3.5" />
                          <span>Copy Link</span>
                        </>
                      )}
                    </button>

                    <button
                      onClick={() => onRevokeInvitation(inv.id)}
                      className="p-1.5 rounded-lg hover:bg-red-950/40 text-slate-500 hover:text-red-400 transition-colors"
                      title="Revoke Token"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* User Roster & Spending Audit */}
      <div className="bg-slate-900/60 border border-slate-800 rounded-3xl p-6 sm:p-8 shadow-xl space-y-4">
        <h3 className="text-base font-bold text-slate-100 flex items-center gap-2">
          <Activity className="w-4 h-4 text-emerald-400" />
          Active Instance Members & Spend Quotas
        </h3>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs sm:text-sm">
            <thead>
              <tr className="border-b border-slate-800 text-slate-400 text-xs uppercase tracking-wider font-semibold">
                <th className="pb-3">User</th>
                <th className="pb-3">Role</th>
                <th className="pb-3">Current Spend</th>
                <th className="pb-3">Monthly Cap</th>
                <th className="pb-3">Tokens Used</th>
                <th className="pb-3">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60 font-mono text-xs">
              {users.map((u) => (
                <tr key={u.id} className="hover:bg-slate-800/30 transition-colors">
                  <td className="py-3.5 font-sans font-medium text-slate-200">
                    <div>{u.name}</div>
                    <div className="text-xs text-slate-500 font-normal">{u.email}</div>
                  </td>
                  <td className="py-3.5">
                    <span className={`px-2 py-0.5 rounded text-[10px] font-sans font-bold uppercase ${
                      u.role === 'admin' 
                        ? 'bg-emerald-950 text-emerald-400 border border-emerald-800/60'
                        : 'bg-slate-800 text-slate-400'
                    }`}>
                      {u.role}
                    </span>
                  </td>
                  <td className="py-3.5 text-emerald-400 font-bold">
                    ${u.currentMonthSpendUsd.toFixed(2)}
                  </td>
                  <td className="py-3.5 text-slate-300">
                    ${u.monthlySpendLimitUsd.toFixed(2)}
                  </td>
                  <td className="py-3.5 text-slate-400">
                    {u.currentMonthTokens.toLocaleString()}
                  </td>
                  <td className="py-3.5 font-sans">
                    <span className="text-emerald-400 text-xs font-semibold flex items-center gap-1">
                      ● Active
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
