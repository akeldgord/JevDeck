import React from 'react';
import { BookOpen, Brain, Shield, Download, Sparkles, DollarSign } from 'lucide-react';
import { User, SystemUsageStats } from '@jevdeck/contracts';

interface HeaderProps {
  activeTab: 'generator' | 'study' | 'admin' | 'export';
  setActiveTab: (tab: 'generator' | 'study' | 'admin' | 'export') => void;
  currentUser: User;
  stats: SystemUsageStats;
  dueCardCount: number;
}

export const Header: React.FC<HeaderProps> = ({
  activeTab,
  setActiveTab,
  currentUser,
  dueCardCount
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
            <button
              onClick={() => setActiveTab('generator')}
              className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                activeTab === 'generator'
                  ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900'
              }`}
            >
              <BookOpen className="w-4 h-4" />
              <span className="hidden md:inline">Generate & Sections</span>
            </button>

            <button
              onClick={() => setActiveTab('study')}
              className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors relative ${
                activeTab === 'study'
                  ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900'
              }`}
            >
              <Brain className="w-4 h-4" />
              <span>Study Deck</span>
              {dueCardCount > 0 && (
                <span className="px-1.5 py-0.2 rounded-full text-[11px] font-bold bg-emerald-500 text-slate-950">
                  {dueCardCount}
                </span>
              )}
            </button>

            <button
              onClick={() => setActiveTab('export')}
              className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                activeTab === 'export'
                  ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900'
              }`}
            >
              <Download className="w-4 h-4" />
              <span className="hidden md:inline">Export Anki</span>
            </button>

            <button
              onClick={() => setActiveTab('admin')}
              className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                activeTab === 'admin'
                  ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900'
              }`}
            >
              <Shield className="w-4 h-4" />
              <span className="hidden md:inline">Admin & Usage</span>
            </button>
          </nav>

          {/* User & Budget Pill */}
          <div className="flex items-center gap-3">
            <div className="hidden lg:flex flex-col items-end text-xs">
              <span className="text-slate-300 font-semibold">{currentUser.name}</span>
              <div className="flex items-center gap-1.5 text-slate-400 font-mono text-[11px]">
                <DollarSign className="w-3 h-3 text-emerald-400 inline" />
                <span>${currentUser.currentMonthSpendUsd.toFixed(2)}</span>
                <span className="text-slate-600">/</span>
                <span>${currentUser.monthlySpendLimitUsd.toFixed(2)}</span>
              </div>
            </div>

            <div className="w-8 h-8 rounded-full bg-slate-800 border border-slate-700 flex items-center justify-center font-bold text-xs text-emerald-400">
              {currentUser.name.split(' ').map(n => n[0]).join('').slice(0, 2)}
            </div>
          </div>
        </div>
      </div>
    </header>
  );
};
