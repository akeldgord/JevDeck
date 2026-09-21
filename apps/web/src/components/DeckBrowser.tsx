import React from 'react';
import {
  BookOpen,
  Download,
  FolderOpen,
  GraduationCap,
  Lock,
  RefreshCw,
  Share2,
  Trash2,
  Users,
} from 'lucide-react';
import { summariseDeckList, type DeckList, type DeckRow } from '../lib/deckList';

/**
 * Deck browsing: every deck the account can reach, with what it can do to each one.
 *
 * This is the screen that makes durable storage visible. Before it, a deck was reachable only by
 * reopening the document it came from on the generate tab, so "return to a deck after signing out"
 * depended on remembering where it was. The list is the server's, so it is the same after a restart
 * as it was before one.
 *
 * Access is drawn, not assumed: an owned deck offers open, study, export and delete; a deck someone
 * else shared offers study, says who owns the source, and explains why export is not on the table
 * rather than showing a button the server would refuse.
 */

interface Props {
  list: DeckList;
  activeDeckId: string | null;
  /** The deck an action is currently running on, so only its row shows as busy. */
  busyDeckId: string | null;
  error: string | null;
  notice: string | null;
  isDemo: boolean;
  canPersist: boolean;
  onOpen: (deckId: string) => void;
  onStudy: (deckId: string) => void;
  onExport: (deckId: string) => void;
  onRemove: (deckId: string) => void;
  onRefresh: () => void;
  refreshing: boolean;
}

const ActionButton: React.FC<{
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  tone?: 'primary' | 'neutral' | 'danger';
  title?: string;
}> = ({ icon, label, onClick, disabled, tone = 'neutral', title }) => {
  const tones: Record<string, string> = {
    primary: 'bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold',
    neutral: 'bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700',
    danger: 'bg-slate-900 hover:bg-red-950/60 text-red-300 border border-red-900/50',
  };

  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`px-3 py-1.5 rounded-lg text-xs inline-flex items-center gap-1.5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${tones[tone]}`}
    >
      {icon}
      {label}
    </button>
  );
};

const DeckCard: React.FC<{
  row: DeckRow;
  busy: boolean;
  isDemo: boolean;
  canPersist: boolean;
  onOpen: () => void;
  onStudy: () => void;
  onExport: () => void;
  onRemove: () => void;
}> = ({ row, busy, isDemo, canPersist, onOpen, onStudy, onExport, onRemove }) => (
  <div
    className={`rounded-2xl border p-5 space-y-4 transition-colors ${
      row.isActive
        ? 'border-emerald-700/70 bg-emerald-950/20'
        : 'border-slate-800 bg-slate-900/50'
    }`}
  >
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="space-y-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <h3 className="text-base font-bold text-slate-100 truncate">{row.title}</h3>
          <span
            className={`text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded border ${
              row.access === 'owner'
                ? 'bg-emerald-950/80 text-emerald-400 border-emerald-800/60'
                : 'bg-amber-950/60 text-amber-300 border-amber-800/50'
            }`}
          >
            {row.accessLabel}
          </span>
          <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-slate-800/80 text-slate-300 border border-slate-700">
            {row.coverageLabel}
          </span>
          {row.isActive && (
            <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-600/50">
              Open now
            </span>
          )}
        </div>
        <p className="text-xs text-slate-400">
          {row.cardCount} card{row.cardCount === 1 ? '' : 's'}
          {row.documentName ? ` · from “${row.documentName}”` : ''}
          {row.access === 'shared' && !row.can.readSource ? ' · source document not shared' : ''}
          {row.access === 'shared' && row.can.readSource ? ' · source document shared' : ''}
        </p>
        {row.description && (
          <p className="text-xs text-slate-500 line-clamp-2">{row.description}</p>
        )}
      </div>
      <p className="text-[11px] text-slate-500 font-mono shrink-0">
        {row.createdAt.slice(0, 10)}
      </p>
    </div>

    <div className="flex flex-wrap items-center gap-2">
      {/* `readSource`, not `open`: an owner opens the generator around their own document, while a
          reader opens the source their share carries. Both land on the viewer; only the owner's
          screen can re-generate. */}
      {row.can.readSource ? (
        <ActionButton
          icon={<FolderOpen className="w-3.5 h-3.5" />}
          label="Open with source"
          onClick={onOpen}
          disabled={busy || isDemo || !canPersist}
          tone="primary"
          title="Loads the deck's cards, your own schedule, and the stored source document."
        />
      ) : (
        <ActionButton
          icon={<FolderOpen className="w-3.5 h-3.5" />}
          label="Open with source"
          onClick={() => undefined}
          disabled
          title={row.sourceBlockedReason ?? row.openBlockedReason ?? 'Not available.'}
        />
      )}

      {row.can.study && (
        <ActionButton
          icon={<GraduationCap className="w-3.5 h-3.5" />}
          label="Study"
          onClick={onStudy}
          disabled={busy}
          title="Opens the deck and goes straight to the study session."
        />
      )}

      {row.can.exportPackage && (
        <ActionButton
          icon={<Download className="w-3.5 h-3.5" />}
          label="Export .apkg"
          onClick={onExport}
          disabled={busy || isDemo || !canPersist}
          title="A real Anki package. Every card arrives new; no review history is transferred."
        />
      )}

      {row.can.share && (
        <span className="text-[11px] text-slate-500 inline-flex items-center gap-1.5">
          <Share2 className="w-3 h-3" /> Share from the Export tab
        </span>
      )}

      {row.can.remove && (
        <ActionButton
          icon={<Trash2 className="w-3.5 h-3.5" />}
          label="Delete"
          onClick={onRemove}
          disabled={busy || isDemo || !canPersist}
          tone="danger"
          title="Deletes the deck and its cards. The document and its versions are kept."
        />
      )}

      {busy && <span className="text-[11px] text-slate-400">Working…</span>}
    </div>

    {!row.can.exportPackage && row.exportBlockedReason && (
      <p className="text-[11px] text-slate-500 inline-flex items-center gap-1.5">
        <Lock className="w-3 h-3" /> {row.exportBlockedReason}
      </p>
    )}

    {row.openBlockedReason && (
      <p className="text-[11px] text-amber-300/90">{row.openBlockedReason}</p>
    )}

    {row.sourceBlockedReason && (
      <p className="text-[11px] text-slate-500">{row.sourceBlockedReason}</p>
    )}
  </div>
);

function Section({
  title,
  count,
  icon,
  empty,
  children,
}: {
  title: string;
  count: number;
  icon: React.ReactNode;
  empty: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        {icon}
        <h2 className="text-sm font-bold uppercase tracking-wider text-slate-300">{title}</h2>
        <span className="text-[11px] font-mono text-slate-500">{count}</span>
      </div>
      {count === 0 ? (
        <p className="text-xs text-slate-500 bg-slate-900/40 border border-slate-800 rounded-2xl px-4 py-3">
          {empty}
        </p>
      ) : (
        <div className="space-y-3">{children}</div>
      )}
    </section>
  );
}

export const DeckBrowser: React.FC<Props> = ({
  list,
  busyDeckId,
  error,
  notice,
  isDemo,
  canPersist,
  onOpen,
  onStudy,
  onExport,
  onRemove,
  onRefresh,
  refreshing,
}) => (
  <div className="max-w-4xl mx-auto space-y-6">
    <div className="flex flex-wrap items-center justify-between gap-3 bg-slate-900/60 border border-slate-800 rounded-3xl px-6 py-5 backdrop-blur-md">
      <div>
        <h1 className="text-xl font-bold text-slate-100 flex items-center gap-2">
          <BookOpen className="w-5 h-5 text-emerald-400" />
          Your decks
        </h1>
        <p className="text-xs text-slate-400 mt-1">
          {summariseDeckList(list)} Every deck on this account and every deck shared with it. Nothing
          here depends on the document still being open: the list and the schedules come from the
          server.
        </p>
      </div>
      <ActionButton
        icon={<RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />}
        label="Refresh"
        onClick={onRefresh}
        disabled={refreshing}
        title="Re-reads the list from the server."
      />
    </div>

    {notice && (
      <div className="rounded-2xl border border-emerald-900/50 bg-emerald-950/20 px-4 py-2 text-xs text-emerald-200">
        {notice}
      </div>
    )}
    {error && (
      <div className="rounded-2xl border border-red-900/50 bg-red-950/20 px-4 py-2 text-xs text-red-200">
        {error}
      </div>
    )}

    <Section
      title="Yours"
      count={list.owned.length}
      icon={<Users className="w-4 h-4 text-emerald-400" />}
      empty="No decks of your own yet. Upload a document on the Generate tab and generate cards to create one."
    >
      {list.owned.map(row => (
        <DeckCard
          key={row.id}
          row={row}
          busy={busyDeckId === row.id}
          isDemo={isDemo}
          canPersist={canPersist}
          onOpen={() => onOpen(row.id)}
          onStudy={() => onStudy(row.id)}
          onExport={() => onExport(row.id)}
          onRemove={() => onRemove(row.id)}
        />
      ))}
    </Section>

    <Section
      title="Shared with you"
      count={list.shared.length}
      icon={<Share2 className="w-4 h-4 text-amber-400" />}
      empty="Nothing is shared with this account. An administrator or another account can share a deck here for study."
    >
      {list.shared.map(row => (
        <DeckCard
          key={row.id}
          row={row}
          busy={busyDeckId === row.id}
          isDemo={isDemo}
          canPersist={canPersist}
          onOpen={() => onOpen(row.id)}
          onStudy={() => onStudy(row.id)}
          onExport={() => onExport(row.id)}
          onRemove={() => onRemove(row.id)}
        />
      ))}
    </Section>
  </div>
);
