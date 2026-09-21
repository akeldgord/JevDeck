import React, { useCallback, useEffect, useState } from 'react';
import { Check, FileText, Loader2, Share2, UserMinus, Users } from 'lucide-react';
import { api } from '../lib/api';
import type { DeckShare, ShareScope, ShareScopeChoice } from '../lib/api';

/**
 * Sharing, in both directions.
 *
 * `SharePanel` is what the owner sees: the accounts allowed to study the deck, and a field to add
 * one by email under one of the two scopes. The scope is a real choice with a real consequence —
 * `study` is the cards and the recipient's own schedule, `study_and_source` adds the document the
 * cards were built from — and the sentence under each choice is the server's own account of what it
 * grants, not a second copy written here. An owner disclosing what they are sharing is the point of
 * the scope, so the disclosure sits above the button rather than in fine print after it.
 *
 * `SharedWithYou` is what a recipient sees in their library: the decks someone else owns, which they
 * can study and — when the share carries it — open at its source.
 *
 * Both talk to the server for every change and re-read the result, so the list on screen is the
 * server's list rather than a local guess about it.
 */

interface SharePanelProps {
  deckId: string | null;
  /** False when the deck is not the caller's, or there is no stored deck to share. */
  canShare: boolean;
}

const SCOPE_LABELS: Record<string, string> = {
  study: 'Study only',
  study_and_source: 'Study and source',
};

/** The scope a share carries, named the way the server names it. */
function scopeLabel(scope: ShareScope | undefined): string {
  return scope ? (SCOPE_LABELS[scope] ?? scope) : 'Study only';
}

export const SharePanel: React.FC<SharePanelProps> = ({ deckId, canShare }) => {
  const [shares, setShares] = useState<DeckShare[]>([]);
  const [scopes, setScopes] = useState<ShareScopeChoice[]>([]);
  const [sourceAvailable, setSourceAvailable] = useState(true);
  const [scope, setScope] = useState<ShareScope>('study');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!deckId || !canShare) {
      setShares([]);
      setScopes([]);
      return;
    }

    try {
      const result = await api.deckShares(deckId);
      setShares(result.shares);
      setScopes(result.scopes ?? []);
      setSourceAvailable(result.sourceAvailable !== false);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The share list could not be read.');
    }
  }, [deckId, canShare]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleShare = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!deckId || email.trim().length === 0) return;

    setBusy(true);
    setError(null);
    setNotice(null);

    try {
      const result = await api.shareDeck(deckId, { email: email.trim(), scope });
      setNotice(
        result.disclosure
          ? `${email.trim()}: ${result.disclosure}`
          : `${email.trim()} can now study this deck.`
      );
      setEmail('');
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That deck could not be shared.');
    } finally {
      setBusy(false);
    }
  };

  const handleRevoke = async (share: DeckShare) => {
    if (!deckId) return;
    const userId = share.userId ?? share.shared_with_user_id;
    if (!userId) return;

    setBusy(true);
    setError(null);
    setNotice(null);

    try {
      await api.revokeShare(deckId, userId);
      setNotice(`${share.email} no longer has access.`);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That access could not be revoked.');
    } finally {
      setBusy(false);
    }
  };

  const chosen = scopes.find(entry => entry.value === scope) ?? scopes[0] ?? null;

  return (
    <div className="bg-slate-900/60 border border-slate-800 rounded-3xl p-6 sm:p-8 backdrop-blur-md shadow-xl space-y-5">
      <div>
        <h2 className="text-xl font-bold text-slate-100 flex items-center gap-2">
          <Users className="w-5 h-5 text-emerald-400" />
          Share this deck
        </h2>
        <p className="text-xs text-slate-400 mt-1 leading-relaxed">
          A recipient keeps their own review schedule. Either way the deck, its cards and its
          re-generation stay yours: nobody else can change, export or delete it.
        </p>
      </div>

      {!canShare ? (
        <p className="text-xs text-slate-500">
          Only the deck's owner can share it. A deck shared with you appears in your library for
          study.
        </p>
      ) : (
        <>
          <form onSubmit={handleShare} className="space-y-3">
            <div className="flex flex-col sm:flex-row gap-2">
              <input
                type="email"
                required
                value={email}
                onChange={event => setEmail(event.target.value)}
                placeholder="name@example.com"
                className="flex-1 rounded-xl bg-slate-950/70 border border-slate-800 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600 focus:outline-none focus:border-emerald-700"
              />
              <button
                type="submit"
                disabled={busy || !deckId}
                className="px-4 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-400 disabled:opacity-40 text-slate-950 font-bold text-xs transition-colors inline-flex items-center justify-center gap-2"
              >
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Share2 className="w-4 h-4" />}
                Share deck
              </button>
            </div>

            {/* The scope is picked before the address is submitted, and the disclosure for the
                chosen scope is shown with it: what a share grants is the whole decision. */}
            {scopes.length > 1 && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {scopes.map(entry => {
                  const disabled = entry.value === 'study_and_source' && !sourceAvailable;
                  const active = entry.value === scope;

                  return (
                    <button
                      key={entry.value}
                      type="button"
                      disabled={disabled}
                      onClick={() => setScope(entry.value)}
                      className={`text-left rounded-2xl border px-3 py-2.5 transition-colors disabled:opacity-40 ${
                        active
                          ? 'border-emerald-600 bg-emerald-950/30'
                          : 'border-slate-800 bg-slate-950/50 hover:border-slate-700'
                      }`}
                    >
                      <span className="flex items-center gap-1.5 text-xs font-bold text-slate-100">
                        {entry.value === 'study_and_source' && <FileText className="w-3.5 h-3.5" />}
                        {entry.label}
                        {active && <Check className="w-3.5 h-3.5 text-emerald-400" />}
                      </span>
                      <span className="block text-[11px] text-slate-400 mt-1 leading-relaxed">
                        {disabled
                          ? 'The original file was not retained for this document, so there is no source to share.'
                          : entry.description}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}

            {chosen && (
              <p className="text-[11px] text-slate-500 leading-relaxed border-l-2 border-slate-800 pl-3">
                {chosen.disclosure}
              </p>
            )}
          </form>

          {shares.length === 0 ? (
            <p className="text-xs text-slate-500">
              This deck is not shared with anyone. Shared accounts need an existing invitation-only
              account; the server rejects an address it does not know.
            </p>
          ) : (
            <ul className="divide-y divide-slate-800/80 rounded-2xl border border-slate-800 overflow-hidden">
              {shares.map(share => {
                const userId = share.userId ?? share.shared_with_user_id ?? share.email;

                return (
                  <li
                    key={userId}
                    className="flex items-center justify-between gap-3 px-4 py-3 bg-slate-950/50"
                  >
                    <div className="min-w-0">
                      <div className="text-sm text-slate-200 truncate">{share.email}</div>
                      <div className="text-[11px] text-slate-500 font-mono">
                        {scopeLabel(share.scope).toLowerCase()}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => void handleRevoke(share)}
                      disabled={busy}
                      className="px-3 py-1.5 rounded-lg border border-slate-700 hover:border-red-800 hover:text-red-300 text-slate-300 text-xs font-semibold transition-colors inline-flex items-center gap-1.5 disabled:opacity-40"
                    >
                      <UserMinus className="w-3.5 h-3.5" />
                      Revoke
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          {notice && (
            <p className="text-[11px] text-emerald-300 inline-flex items-start gap-1.5 leading-relaxed">
              <Check className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              <span>{notice}</span>
            </p>
          )}
          {error && <p className="text-[11px] text-red-300">{error}</p>}
        </>
      )}
    </div>
  );
};

interface SharedWithYouProps {
  decks: Array<{ id: string; title: string; cardCount: number; sourceAccess?: boolean }>;
  onOpen: (deckId: string) => void;
  busyDeckId: string | null;
}

export const SharedWithYou: React.FC<SharedWithYouProps> = ({ decks, onOpen, busyDeckId }) => {
  if (decks.length === 0) return null;

  const anySource = decks.some(deck => deck.sourceAccess);

  return (
    <div className="bg-slate-900/60 border border-slate-800 rounded-3xl p-6 backdrop-blur-md shadow-xl space-y-4">
      <div>
        <h2 className="text-lg font-bold text-slate-100 flex items-center gap-2">
          <Users className="w-4 h-4 text-emerald-400" />
          Shared with you
        </h2>
        <p className="text-xs text-slate-400 mt-1 leading-relaxed">
          {anySource
            ? 'Decks other accounts have opened for you. You can review the cards, and open the source of a deck whose share covers it; the deck itself belongs to its owner.'
            : 'Decks other accounts have opened for study. You can review the cards; the deck and its source document belong to the owner.'}
        </p>
      </div>

      <ul className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {decks.map(deck => (
          <li
            key={deck.id}
            className="flex items-center justify-between gap-3 rounded-2xl border border-slate-800 bg-slate-950/50 px-4 py-3"
          >
            <div className="min-w-0">
              <div className="text-sm text-slate-200 truncate">{deck.title}</div>
              <div className="text-[11px] text-slate-500 font-mono">
                {deck.cardCount} card{deck.cardCount === 1 ? '' : 's'}
                {deck.sourceAccess ? ' · source included' : ' · study only'}
              </div>
            </div>
            <button
              type="button"
              onClick={() => onOpen(deck.id)}
              disabled={busyDeckId === deck.id}
              className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-100 text-xs font-semibold transition-colors inline-flex items-center gap-1.5 disabled:opacity-40"
            >
              {busyDeckId === deck.id && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              Open
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
};
