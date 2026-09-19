import React from 'react';
import {
  BookOpen,
  Brain,
  Shield,
  Download,
  Sparkles,
  DollarSign,
  UserRound,
  LogOut,
} from 'lucide-react';
import { SimulatedBadge } from './DemoBanner';

export type AppTab = 'generator' | 'study' | 'admin' | 'export';

export interface HeaderUser {
  name: string;
  email: string;
  role: 'admin' | 'member';
}

interface HeaderProps {
  activeTab: AppTab;
  setActiveTab: (tab: AppTab) => void;
  /**
   * The signed-in user, or `null` when there is no session.
   *
   * Never falls back to a synthetic account: an installation without a session shows that it
   * has none.
   */
  currentUser: HeaderUser | null;
  /** Spend figures, when something actually tracks them. `null` means nothing does. */
  budget: { usedUsd: number; limitUsd: number } | null;
  isDemo: boolean;
  dueCardCount: number;
  onSignOut?: (() => void) | null;
}

export const Header: React.FC<HeaderProps> = ({
  activeTab,
  setActiveTab,
  currentUser,
  budget,
  isDemo,
  dueCardCount,
  onSignOut,
}) => {
  return (
    <header className="border-b border-slate-800/80 bg-slate-950/70 backdrop-blur-md sticky top-0 z-40">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          {/* Brand */}
          <div className="flex items-center gap-3 cursor-pointer" onClick={() => setActiveTab('generator')}>
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-700 flex items-center justify-center shadow-lg shadow-emerald-900/30">
              <Sparkles className="w-5 h-5 text-white" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-extrabold text-xl tracking-tight bg-gradient-to-r from-emerald-400 via-teal-300 to-cyan-400 bg-clip-text text-transparent">
                  JevDeck
                </span>
                <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-emerald-950/80 text-emerald-400 border border-emerald-800/60">
                  v0.1
                </span>
              </div>
              <p className="text-xs text-slate-400 font-medium hidden sm:block">
                Turn documents into flashcards worth remembering
              </p>
            </div>
          </div>

          {/* Navigation tabs */}
          <nav className="flex items-center gap-1 sm:gap-2">
            <TabButton
              active={activeTab === 'generator'}
              onClick={() => setActiveTab('generator')}
              icon={<BookOpen className="w-4 h-4" />}
              label="Generate & Sections"
            />
            <TabButton
              active={activeTab === 'study'}
              onClick={() => setActiveTab('study')}
              icon={<Brain className="w-4 h-4" />}
              label="Study Deck"
              badge={dueCardCount > 0 ? dueCardCount : undefined}
            />
            <TabButton
              active={activeTab === 'export'}
              onClick={() => setActiveTab('export')}
              icon={<Download className="w-4 h-4" />}
              label="Export"
            />
            <TabButton
              active={activeTab === 'admin'}
              onClick={() => setActiveTab('admin')}
              icon={<Shield className="w-4 h-4" />}
              label="Admin & Usage"
            />
          </nav>

          {/* Session and budget */}
          <div className="flex items-center gap-3">
            {currentUser ? (
              <>
                <div className="hidden lg:flex flex-col items-end text-xs">
                  <span className="text-slate-300 font-semibold flex items-center gap-1.5">
                    {currentUser.name}
                    {isDemo && <SimulatedBadge label="Demo" />}
                  </span>
                  {budget ? (
                    <div className="flex items-center gap-1.5 text-slate-400 font-mono text-[11px]">
                      <DollarSign className="w-3 h-3 text-emerald-400 inline" />
                      <span>${budget.usedUsd.toFixed(2)}</span>
                      <span className="text-slate-600">/</span>
                      <span>${budget.limitUsd.toFixed(2)}</span>
                      {isDemo && <span className="text-amber-500/80 font-sans">simulated</span>}
                    </div>
                  ) : (
                    <span className="text-slate-500 text-[11px]">
                      {currentUser.role === 'admin' ? 'Administrator' : 'Member'} · spend not tracked yet
                    </span>
                  )}
                </div>

                <div
                  className="w-8 h-8 rounded-full bg-slate-800 border border-slate-700 flex items-center justify-center font-bold text-xs text-emerald-400"
                  title={`${currentUser.name} — ${currentUser.email}`}
                >
                  {currentUser.name
                    .split(' ')
                    .map(part => part[0])
                    .join('')
                    .slice(0, 2)}
                </div>

                {onSignOut && (
                  <button
                    onClick={onSignOut}
                    title="Sign out"
                    className="p-2 rounded-lg bg-slate-900 border border-slate-800 text-slate-400 hover:text-slate-100 hover:bg-slate-800 transition-colors"
                  >
                    <LogOut className="w-4 h-4" />
                  </button>
                )}
              </>
            ) : (
              <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-slate-900 border border-slate-800 text-xs text-slate-400">
                <UserRound className="w-3.5 h-3.5" />
                <span className="font-medium">Not signed in</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </header>
  );
};

interface TabButtonProps {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  badge?: number;
}

const TabButton: React.FC<TabButtonProps> = ({ active, onClick, icon, label, badge }) => (
  <button
    onClick={onClick}
    className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors relative ${
      active
        ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30'
        : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900'
    }`}
  >
    {icon}
    <span className="hidden md:inline">{label}</span>
    {badge !== undefined && (
      <span className="px-1.5 py-0.2 rounded-full text-[11px] font-bold bg-emerald-500 text-slate-950">
        {badge}
      </span>
    )}
  </button>
);
