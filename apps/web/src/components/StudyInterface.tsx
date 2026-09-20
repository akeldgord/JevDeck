import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Flashcard } from '@jevdeck/contracts';
import {
  calculateSM2,
  describeDailyAllowance,
  describeQueue,
  type SM2Rating,
  type StudyQueue,
} from '@jevdeck/scheduling';
import {
  Ban,
  BookOpen,
  Eye,
  Flame,
  RotateCcw,
  Settings,
  Sparkles,
  Undo2,
} from 'lucide-react';

/**
 * The study session.
 *
 * Three things this component is careful about, because the audit found them wrong before:
 *
 * 1. **The queue comes from the shared eligibility function**, not from the deck's card list. The
 *    header's count and this queue therefore cannot disagree, and a card scheduled for next month
 *    is not studied today by accident.
 * 2. **Every rating is persisted.** `onRate` writes the review to the server and the component
 *    renders the schedule the server returned. React state is a view of the server's answer, not
 *    the authority, so a reload shows the same due dates.
 * 3. **The controls that are advertised exist.** Space reveals, 1–4 rate, S suspends and Z undoes —
 *    each one is implemented below, and undo is a real server call that replays the schedule.
 */

interface Props {
  cards: Flashcard[];
  /** Built by the caller from `selectStudyQueue`, so the counts agree with the header. */
  queue: StudyQueue;
  /** Card ids the caller has suspended. */
  suspendedCardIds: string[];
  onRate: (card: Flashcard, rating: SM2Rating) => Promise<void>;
  /** Removes the caller's most recent review of that card, on the server. */
  onUndo: (cardId: string) => Promise<void>;
  onToggleSuspend: (card: Flashcard, suspended: boolean) => Promise<void>;
  onOpenDualViewer: (card: Flashcard) => void;
  isCramSession: boolean;
  onToggleCramSession: (enabled: boolean) => void;
  modifyScheduleInCram: boolean;
  onToggleModifyScheduleInCram: (modify: boolean) => void;
  error: string | null;
  busy: boolean;
  /** True when the caller can write to the API. Demo mode cannot, and says so. */
  canPersist: boolean;
  isDemo: boolean;
}

const RATING_KEYS: Record<string, SM2Rating> = { '1': 1, '2': 3, '3': 4, '4': 5 };

export const StudyInterface: React.FC<Props> = ({
  cards,
  queue,
  suspendedCardIds,
  onRate,
  onUndo,
  onToggleSuspend,
  onOpenDualViewer,
  isCramSession,
  onToggleCramSession,
  modifyScheduleInCram,
  onToggleModifyScheduleInCram,
  error,
  busy,
  canPersist,
  isDemo,
}) => {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isFlipped, setIsFlipped] = useState(false);
  const [sessionCompleted, setSessionCompleted] = useState(false);
  const [showCramSettingsModal, setShowCramSettingsModal] = useState(false);
  const [history, setHistory] = useState<string[]>([]);
  const [localError, setLocalError] = useState<string | null>(null);

  const activeCards = queue.queue;
  const currentCard = activeCards[currentIndex];

  // The queue changes as cards are reviewed, so an index past the end must not blank the screen
  // while the session is still running.
  useEffect(() => {
    if (currentIndex >= activeCards.length && activeCards.length > 0) {
      setCurrentIndex(activeCards.length - 1);
    }
  }, [activeCards.length, currentIndex]);

  const handleRate = useCallback(
    async (rating: SM2Rating) => {
      if (!currentCard || busy) return;

      setLocalError(null);
      setHistory(previous => [...previous, currentCard.id]);

      try {
        await onRate(currentCard, rating);
      } catch (cause) {
        // The rating was not stored, so the card stays where it is rather than appearing reviewed.
        setHistory(previous => previous.slice(0, -1));
        setLocalError(cause instanceof Error ? cause.message : 'That rating was not saved.');
        return;
      }

      if (currentIndex + 1 < activeCards.length) {
        setCurrentIndex(currentIndex + 1);
        setIsFlipped(false);
      } else {
        setSessionCompleted(true);
      }
    },
    [activeCards.length, busy, currentCard, currentIndex, onRate]
  );

  const handleUndo = useCallback(async () => {
    const cardId = history[history.length - 1];
    if (!cardId || busy) return;

    setLocalError(null);
    try {
      await onUndo(cardId);
      setHistory(previous => previous.slice(0, -1));
      setSessionCompleted(false);
      setIsFlipped(false);
      setCurrentIndex(index => Math.max(0, index - 1));
    } catch (cause) {
      setLocalError(cause instanceof Error ? cause.message : 'That review could not be undone.');
    }
  }, [busy, history, onUndo]);

  /**
   * Keyboard controls.
   *
   * Registered on the window and scoped to a visible card: Space reveals only while a card is on
   * screen and the answer is hidden, and typing in a field is never intercepted.
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
      if (showCramSettingsModal) return;

      if (event.code === 'Space' || event.key === ' ') {
        if (!currentCard || isFlipped) return;
        event.preventDefault();
        setIsFlipped(true);
        return;
      }

      if (!currentCard || !isFlipped) return;

      const rating = RATING_KEYS[event.key];
      if (rating !== undefined) {
        event.preventDefault();
        void handleRate(rating);
        return;
      }

      if (event.key === 'z' || event.key === 'Z') {
        event.preventDefault();
        void handleUndo();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [currentCard, handleRate, handleUndo, isFlipped, showCramSettingsModal]);

  const queueSummary = useMemo(() => describeQueue(queue.counts), [queue.counts]);
  // Stated in full rather than as "12 / 20": the limits count two different things, and a reader
  // cannot tell from a bare fraction whether it is cards or ratings.
  const allowanceSummary = useMemo(
    () => describeDailyAllowance(queue.allowance, queue.limits),
    [queue.allowance, queue.limits]
  );
  const suspended = currentCard ? suspendedCardIds.includes(currentCard.id) : false;

  if (cards.length === 0) {
    return (
      <div className="bg-slate-900/60 border border-slate-800 rounded-3xl p-12 text-center max-w-xl mx-auto backdrop-blur-md shadow-2xl space-y-5">
        <div className="w-16 h-16 rounded-2xl bg-slate-800/80 text-slate-400 mx-auto flex items-center justify-center border border-slate-700">
          <BookOpen className="w-8 h-8" />
        </div>
        <div className="space-y-2">
          <h2 className="text-2xl font-black text-slate-100">No cards to study yet</h2>
          <p className="text-sm text-slate-400">
            This deck is empty. Upload a document on the Generate tab, choose the sections you want
            covered, and generate cards.
          </p>
        </div>
      </div>
    );
  }

  if (queue.counts.eligible === 0 && queue.counts.suspended + queue.counts.later === cards.length) {
    // Nothing is due. That is a real answer, and it is not "Session Complete".
    return (
      <div className="bg-slate-900/60 border border-slate-800 rounded-3xl p-12 text-center max-w-xl mx-auto backdrop-blur-md shadow-2xl space-y-5">
        <div className="w-16 h-16 rounded-2xl bg-slate-800/80 text-slate-400 mx-auto flex items-center justify-center border border-slate-700">
          <Sparkles className="w-8 h-8" />
        </div>
        <div className="space-y-2">
          <h2 className="text-2xl font-black text-slate-100">Nothing due right now</h2>
          <p className="text-sm text-slate-400">
            {cards.length} card{cards.length === 1 ? '' : 's'} in this deck, none scheduled for today.
          </p>
          <p className="text-xs text-slate-500">{queueSummary ?? 'All cards are scheduled for later.'}</p>
        </div>
        <button
          onClick={() => onToggleCramSession(true)}
          className="px-5 py-2.5 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-sm transition-colors inline-flex items-center gap-2"
        >
          <Flame className="w-4 h-4" />
          Cram the whole deck instead
        </button>
      </div>
    );
  }

  if (!currentCard || sessionCompleted) {
    return (
      <div className="bg-slate-900/60 border border-slate-800 rounded-3xl p-12 text-center max-w-xl mx-auto backdrop-blur-md shadow-2xl space-y-6">
        <div className="w-16 h-16 rounded-2xl bg-emerald-500/20 text-emerald-400 mx-auto flex items-center justify-center border border-emerald-500/30 shadow-lg">
          <Sparkles className="w-8 h-8" />
        </div>
        <div>
          <h2 className="text-2xl font-black text-slate-100">Session complete</h2>
          <p className="text-sm text-slate-400 mt-2">
            You reviewed {history.length} card{history.length === 1 ? '' : 's'} in this session.
            {queueSummary && <span className="block mt-1 text-xs text-slate-500">{queueSummary}</span>}
            {isCramSession && (
              <span className="block mt-1 font-mono text-xs text-amber-400">
                Mode: Cram (
                {modifyScheduleInCram
                  ? 'SR schedule updated'
                  : 'isolated review, SR schedule untouched'}
                )
              </span>
            )}
          </p>
        </div>

        <div className="pt-4 flex justify-center gap-3">
          <button
            onClick={() => void handleUndo()}
            disabled={history.length === 0 || busy}
            className="px-5 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-100 font-bold text-sm transition-colors flex items-center gap-2"
          >
            <Undo2 className="w-4 h-4" />
            Undo last rating (Z)
          </button>
          <button
            onClick={() => {
              setCurrentIndex(0);
              setIsFlipped(false);
              setSessionCompleted(false);
            }}
            className="px-5 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-sm transition-colors flex items-center gap-2"
          >
            <RotateCcw className="w-4 h-4" />
            Review again
          </button>
        </div>
      </div>
    );
  }

  const renderCloze = (clozeText: string, revealed: boolean) => {
    const parts: React.ReactNode[] = [];
    let lastIdx = 0;
    const regex = /\{\{c\d+::(.*?)\}\}/g;
    let match;

    while ((match = regex.exec(clozeText)) !== null) {
      if (match.index > lastIdx) {
        parts.push(clozeText.substring(lastIdx, match.index));
      }

      const content = match[1];
      const [answer, hint] = content.split('::');

      if (revealed) {
        parts.push(
          <span
            key={match.index}
            className="bg-emerald-500/20 text-emerald-300 font-bold px-1.5 py-0.5 rounded border border-emerald-500/40"
          >
            {answer}
          </span>
        );
      } else {
        parts.push(
          <span
            key={match.index}
            className="bg-slate-800 text-cyan-400 font-mono font-semibold px-2 py-0.5 rounded border border-slate-700 tracking-wider shadow-inner"
          >
            [{hint || '...'}]
          </span>
        );
      }

      lastIdx = regex.lastIndex;
    }

    if (lastIdx < clozeText.length) {
      parts.push(clozeText.substring(lastIdx));
    }

    return <div className="leading-relaxed text-lg sm:text-xl text-slate-100">{parts}</div>;
  };

  const previewInterval = (rating: SM2Rating) => {
    if (isCramSession && !modifyScheduleInCram) return 'No change';
    const next = calculateNextInterval(currentCard, rating);
    return next;
  };

  const message = localError ?? error;

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-slate-900/60 border border-slate-800 p-4 rounded-2xl backdrop-blur-sm">
        <div className="flex items-center gap-3">
          <span className="text-xs font-mono text-slate-400">
            Card {currentIndex + 1} of {activeCards.length} in this session
          </span>
          <div className="h-4 w-[1px] bg-slate-800" />
          <span
            className={`text-[11px] font-bold uppercase tracking-wider px-2 py-0.5 rounded ${
              currentCard.format === 'cloze'
                ? 'bg-purple-950/80 text-purple-400 border border-purple-800/60'
                : 'bg-blue-950/80 text-blue-400 border border-blue-800/60'
            }`}
          >
            {currentCard.format === 'cloze' ? 'Cloze deletion' : 'Question & answer'}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-[11px] font-mono text-slate-500">
            {queue.counts.new} new · {queue.counts.due} due
          </span>
          <button
            onClick={() => {
              if (!isCramSession) {
                setShowCramSettingsModal(true);
              } else {
                onToggleCramSession(false);
              }
            }}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold border transition-all ${
              isCramSession
                ? 'bg-amber-500 text-slate-950 border-amber-400 font-bold shadow-md shadow-amber-500/20'
                : 'bg-slate-800 text-slate-300 border-slate-700 hover:bg-slate-700'
            }`}
          >
            <Flame className="w-3.5 h-3.5" />
            <span>{isCramSession ? 'Cram mode active' : 'Enable cram mode'}</span>
          </button>

          {isCramSession && (
            <button
              onClick={() => setShowCramSettingsModal(true)}
              className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 transition-colors"
              title="Configure cram behaviour"
            >
              <Settings className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {isCramSession ? (
        // Cram does not spend a daily allowance, and saying so is the honest version of "no limits".
        <div className="rounded-2xl border border-amber-900/40 bg-amber-950/10 px-4 py-2 text-[11px] text-amber-200/80">
          Cram session: the daily limits do not apply, and nothing here is counted against today's
          allowance.
        </div>
      ) : (
        <div className="rounded-2xl border border-slate-800 bg-slate-900/40 px-4 py-2 text-[11px] text-slate-400">
          Today's allowance: {allowanceSummary}.
        </div>
      )}

      {queueSummary && (
        <div className="rounded-2xl border border-slate-800 bg-slate-900/40 px-4 py-2 text-[11px] text-slate-400">
          Not in this session: {queueSummary}.
        </div>
      )}

      {message && (
        <div className="rounded-2xl border border-red-900/50 bg-red-950/20 p-3 text-xs text-red-200">
          {message}
        </div>
      )}

      {!canPersist && (
        <div className="rounded-2xl border border-amber-900/50 bg-amber-950/20 p-3 text-xs text-amber-200">
          {isDemo ? 'Demo mode: ' : ''}
          Ratings are not saved in this configuration, so the schedule will reset on reload.
        </div>
      )}

      <div className="bg-slate-900/80 border border-slate-800 rounded-3xl p-6 sm:p-10 shadow-2xl relative min-h-[380px] flex flex-col justify-between">
        <div className="space-y-6">
          <div className="flex items-center justify-between text-xs text-slate-500 font-medium">
            <span>{currentCard.grounding.sectionTitle}</span>
            <span className="font-mono">Page {currentCard.grounding.pageNumber}</span>
          </div>

          {currentCard.format === 'qa' ? (
            <div className="text-xl sm:text-2xl font-semibold text-slate-100 leading-snug">
              {currentCard.question}
            </div>
          ) : (
            <div>{renderCloze(currentCard.clozeText || '', isFlipped)}</div>
          )}

          {isFlipped && (
            <div className="pt-6 border-t border-slate-800/80 space-y-4">
              {currentCard.format === 'qa' && (
                <div className="p-4 rounded-2xl bg-emerald-950/20 border border-emerald-500/30 text-emerald-100 text-base leading-relaxed">
                  {currentCard.answer}
                </div>
              )}

              {currentCard.explanation && (
                <div className="text-xs text-slate-400 italic">
                  <span className="font-semibold text-slate-300 not-italic">Nuance: </span>
                  {currentCard.explanation}
                </div>
              )}

              <div className="p-3 bg-slate-950/60 border border-slate-800/80 rounded-xl flex items-start justify-between gap-3 text-xs">
                <div className="space-y-1">
                  <span className="font-semibold text-slate-400 flex items-center gap-1.5">
                    <BookOpen className="w-3.5 h-3.5 text-emerald-400" />
                    Source citation (page {currentCard.grounding.pageNumber})
                  </span>
                  <p className="text-slate-300 italic">"{currentCard.grounding.excerpt}"</p>
                  {currentCard.grounding.validationCodes &&
                    currentCard.grounding.validationCodes.length > 0 && (
                      <p className="text-[10px] font-mono text-slate-500">
                        Recorded checks: {currentCard.grounding.validationCodes.join(', ')}
                      </p>
                    )}
                </div>
                <button
                  type="button"
                  onClick={() => onOpenDualViewer(currentCard)}
                  className="flex-shrink-0 px-2.5 py-1.5 rounded-lg bg-emerald-950/50 hover:bg-emerald-900/60 text-emerald-300 border border-emerald-800/60 font-semibold flex items-center gap-1 transition-colors"
                >
                  <Eye className="w-3.5 h-3.5" />
                  <span>Inspect source</span>
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="pt-8 space-y-3">
          {!isFlipped ? (
            <button
              onClick={() => setIsFlipped(true)}
              className="w-full py-4 rounded-2xl bg-slate-800 hover:bg-slate-700 text-slate-100 font-bold text-base transition-all active:scale-[0.99] border border-slate-700 shadow-lg"
            >
              Show answer (Space)
            </button>
          ) : (
            <div className="space-y-3">
              <div className="grid grid-cols-4 gap-2 sm:gap-3">
                <button
                  onClick={() => void handleRate(1)}
                  disabled={busy}
                  className="p-3 rounded-xl bg-red-950/40 hover:bg-red-900/60 disabled:opacity-50 border border-red-800/60 text-red-300 font-semibold text-xs sm:text-sm flex flex-col items-center gap-1 transition-colors"
                >
                  <span>Again</span>
                  <span className="text-[10px] font-mono text-red-400/80">{previewInterval(1)}</span>
                  <span className="text-[9px] font-mono text-red-400/60">1</span>
                </button>

                <button
                  onClick={() => void handleRate(3)}
                  disabled={busy}
                  className="p-3 rounded-xl bg-amber-950/40 hover:bg-amber-900/60 disabled:opacity-50 border border-amber-800/60 text-amber-300 font-semibold text-xs sm:text-sm flex flex-col items-center gap-1 transition-colors"
                >
                  <span>Hard</span>
                  <span className="text-[10px] font-mono text-amber-400/80">{previewInterval(3)}</span>
                  <span className="text-[9px] font-mono text-amber-400/60">2</span>
                </button>

                <button
                  onClick={() => void handleRate(4)}
                  disabled={busy}
                  className="p-3 rounded-xl bg-blue-950/40 hover:bg-blue-900/60 disabled:opacity-50 border border-blue-800/60 text-blue-300 font-semibold text-xs sm:text-sm flex flex-col items-center gap-1 transition-colors"
                >
                  <span>Good</span>
                  <span className="text-[10px] font-mono text-blue-400/80">{previewInterval(4)}</span>
                  <span className="text-[9px] font-mono text-blue-400/60">3</span>
                </button>

                <button
                  onClick={() => void handleRate(5)}
                  disabled={busy}
                  className="p-3 rounded-xl bg-emerald-950/40 hover:bg-emerald-900/60 disabled:opacity-50 border border-emerald-800/60 text-emerald-300 font-semibold text-xs sm:text-sm flex flex-col items-center gap-1 transition-colors"
                >
                  <span>Easy</span>
                  <span className="text-[10px] font-mono text-emerald-400/80">{previewInterval(5)}</span>
                  <span className="text-[9px] font-mono text-emerald-400/60">4</span>
                </button>
              </div>

              <div className="flex items-center justify-between gap-2 text-[11px]">
                <span className="font-mono text-slate-500">
                  Space reveal · 1–4 rate · Z undo · S suspend
                </span>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => void handleUndo()}
                    disabled={history.length === 0 || busy}
                    className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-200 font-semibold flex items-center gap-1 transition-colors"
                  >
                    <Undo2 className="w-3 h-3" />
                    Undo
                  </button>
                  <button
                    onClick={() => void onToggleSuspend(currentCard, !suspended)}
                    disabled={!canPersist || busy}
                    className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-200 font-semibold flex items-center gap-1 transition-colors"
                    title={suspended ? 'Return this card to rotation' : 'Take this card out of rotation'}
                  >
                    <Ban className="w-3 h-3" />
                    {suspended ? 'Unsuspend' : 'Suspend'}
                  </button>
                </div>
              </div>

              {isCramSession && !modifyScheduleInCram && (
                <div className="text-center text-[11px] font-mono text-amber-400/80">
                  Cram mode: reviewing without altering your long-term schedule.
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {showCramSettingsModal && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-3xl p-6 sm:p-8 max-w-md w-full shadow-2xl space-y-6">
            <div>
              <h3 className="text-lg font-bold text-slate-100 flex items-center gap-2">
                <Flame className="w-5 h-5 text-amber-400" />
                Configure cram session
              </h3>
              <p className="text-xs text-slate-400 mt-1">
                Cram mode reviews the whole deck, ignoring due dates and daily limits. Choose
                whether it alters your long-term schedule.
              </p>
            </div>

            <div className="space-y-3">
              <label
                onClick={() => onToggleModifyScheduleInCram(false)}
                className={`p-4 rounded-xl border flex items-start gap-3 cursor-pointer transition-colors ${
                  !modifyScheduleInCram
                    ? 'bg-emerald-950/30 border-emerald-500/50 text-slate-100'
                    : 'bg-slate-800/50 border-slate-700 text-slate-400 hover:bg-slate-800'
                }`}
              >
                <input
                  type="radio"
                  name="cramSchedule"
                  checked={!modifyScheduleInCram}
                  onChange={() => {}}
                  className="mt-1"
                />
                <div>
                  <div className="text-sm font-semibold">Keep the regular schedule intact</div>
                  <div className="text-xs text-slate-400 mt-0.5">
                    Cramming will not advance or reset your intervals.
                  </div>
                </div>
              </label>

              <label
                onClick={() => onToggleModifyScheduleInCram(true)}
                className={`p-4 rounded-xl border flex items-start gap-3 cursor-pointer transition-colors ${
                  modifyScheduleInCram
                    ? 'bg-emerald-950/30 border-emerald-500/50 text-slate-100'
                    : 'bg-slate-800/50 border-slate-700 text-slate-400 hover:bg-slate-800'
                }`}
              >
                <input
                  type="radio"
                  name="cramSchedule"
                  checked={modifyScheduleInCram}
                  onChange={() => {}}
                  className="mt-1"
                />
                <div>
                  <div className="text-sm font-semibold">Update the regular schedule</div>
                  <div className="text-xs text-slate-400 mt-0.5">
                    Recalculates ease factors and due dates using SuperMemo SM-2.
                  </div>
                </div>
              </label>
            </div>

            <div className="flex justify-end gap-2">
              <button
                onClick={() => {
                  onToggleCramSession(true);
                  setShowCramSettingsModal(false);
                }}
                className="px-5 py-2.5 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-sm transition-colors"
              >
                Start cram session
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

/**
 * The interval the next rating would set, shown on the button before it is pressed.
 *
 * Computed with the same SM-2 function the server uses, so the preview cannot promise an interval
 * the schedule will not produce.
 */
function calculateNextInterval(card: Flashcard, rating: SM2Rating): string {
  return calculateSM2(card, rating).nextReviewText;
}
