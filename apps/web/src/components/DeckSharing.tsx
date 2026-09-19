import React, { useCallback, useEffect, useState } from 'react';
import { Check, Loader2, Share2, UserMinus, Users } from 'lucide-react';
import { api, DeckShare } from '../lib/api';

/**
 * Sharing, in both directions.
 *
 * `SharePanel` is what the owner sees: the accounts currently allowed to study the deck, and a
 * field to add one by email. `SharedWithYou` is what a recipient sees in their library: the decks
 * someone else owns, which they can study but not change, export, or read the source of.
 *
 * Both talk to the server for every change and re-read the result, so the list on screen is the
 * server's list rather than a local guess about it.
 */

interface SharePanelProps {
  deckId: string | null;
  /** False when the deck is not the caller's, or there is no stored deck to share. */
  canShare: boolean;
}

export const SharePanel: React.FC<SharePanelProps> = ({ deckId, canShare }) => {
  const [shares, setShares] = useState<DeckShare[]>([]);
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!deckId || !canShare) {
      setShares([]);
      return;
    }

    try {
      const result = await api.deckShares(deckId);
      setShares(result.shares);
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
      await api.shareDeck(deckId, { email: email.trim(), scope: 'study' });
      setNotice(`${email.trim()} can now study this deck.`);
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

  return (
    <div className="bg-slate-900/60 border border-slate-800 rounded-3xl p-6 sm:p-8 backdrop-blur-md shadow-xl space-y-5">
      <div>
        <h2 className="text-xl font-bold text-slate-100 flex items-center gap-2">
          <Users className="w-5 h-5 text-emerald-400" />
          Share for study
        </h2>
        <p className="text-xs text-slate-400 mt-1 leading-relaxed">
          Someone you share with can review this deck's cards and keep their own schedule. They
          cannot change the deck, export it, or open the original document — that stays with you.
        </p>
      </div>

      {!canShare ? (
        <p className="text-xs text-slate-500">
          Only the deck's owner can share it. A deck shared with you appears in your library for
          study.
        </p>
      ) : (
        <>
          <form onSubmit={handleShare} className="flex flex-col sm:flex-row gap-2">
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
                        study access only
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
            <p className="text-[11px] text-emerald-300 inline-flex items-center gap-1.5">
              <Check className="w-3.5 h-3.5" />
              {notice}
            </p>
          )}
          {error && <p className="text-[11px] text-red-300">{error}</p>}
        </>
      )}
    </div>
  );
};

interface SharedWithYouProps {
  decks: Array<{ id: string; title: string; cardCount: number }>;
  onOpen: (deckId: string) => void;
  busyDeckId: string | null;
}

export const SharedWithYou: React.FC<SharedWithYouProps> = ({ decks, onOpen, busyDeckId }) => {
  if (decks.length === 0) return null;

  return (
    <div className="bg-slate-900/60 border border-slate-800 rounded-3xl p-6 backdrop-blur-md shadow-xl space-y-4">
      <div>
        <h2 className="text-lg font-bold text-slate-100 flex items-center gap-2">
          <Users className="w-4 h-4 text-emerald-400" />
          Shared with you
        </h2>
        <p className="text-xs text-slate-400 mt-1">
          Decks other accounts have opened for study. You can review the cards; the deck and its
          source document belong to the owner.
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
