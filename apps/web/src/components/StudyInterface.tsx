import React, { useState } from 'react';
import { 
  Flashcard 
} from '@jevdeck/contracts';
import { 
  SM2Rating, 
  applyStudyReview, 
  calculateSM2 
} from '@jevdeck/scheduling';
import { 
  RotateCcw, 
  Flame, 
  Sparkles, 
  BookOpen, 
  Eye,
  Settings
} from 'lucide-react';

interface Props {
  cards: Flashcard[];
  onUpdateCard: (updated: Flashcard) => void;
  onOpenDualViewer: (card: Flashcard) => void;
  isCramSession: boolean;
  onToggleCramSession: (enabled: boolean) => void;
  modifyScheduleInCram: boolean;
  onToggleModifyScheduleInCram: (modify: boolean) => void;
}

export const StudyInterface: React.FC<Props> = ({
  cards,
  onUpdateCard,
  onOpenDualViewer,
  isCramSession,
  onToggleCramSession,
  modifyScheduleInCram,
  onToggleModifyScheduleInCram,
}) => {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isFlipped, setIsFlipped] = useState(false);
  const [sessionCompleted, setSessionCompleted] = useState(false);
  const [showCramSettingsModal, setShowCramSettingsModal] = useState(false);

  // Filter cards if cramming or studying
  const activeCards = cards;
  const currentCard = activeCards[currentIndex];

  if (!currentCard || sessionCompleted) {
    return (
      <div className="bg-slate-900/60 border border-slate-800 rounded-3xl p-12 text-center max-w-xl mx-auto backdrop-blur-md shadow-2xl space-y-6">
        <div className="w-16 h-16 rounded-2xl bg-emerald-500/20 text-emerald-400 mx-auto flex items-center justify-center border border-emerald-500/30 shadow-lg shadow-emerald-900/30">
          <Sparkles className="w-8 h-8" />
        </div>
        <div>
          <h2 className="text-2xl font-black text-slate-100">Session Complete!</h2>
          <p className="text-sm text-slate-400 mt-2">
            You reviewed all cards in this session.
            {isCramSession && (
              <span className="block mt-1 font-mono text-xs text-amber-400">
                Mode: Cram ({modifyScheduleInCram ? 'SR Schedule Updated' : 'Isolated Review, SR Schedule Untouched'})
              </span>
            )}
          </p>
        </div>

        <div className="pt-4 flex justify-center gap-3">
          <button
            onClick={() => {
              setCurrentIndex(0);
              setIsFlipped(false);
              setSessionCompleted(false);
            }}
            className="px-5 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-sm transition-colors flex items-center gap-2"
          >
            <RotateCcw className="w-4 h-4" />
            Review Again
          </button>
        </div>
      </div>
    );
  }

  const handleRate = (rating: SM2Rating) => {
    const updatedCard = applyStudyReview(
      currentCard,
      rating,
      isCramSession,
      modifyScheduleInCram
    );
    onUpdateCard(updatedCard);

    if (currentIndex + 1 < activeCards.length) {
      setCurrentIndex(currentIndex + 1);
      setIsFlipped(false);
    } else {
      setSessionCompleted(true);
    }
  };

  // Render Cloze question
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

  // Preview intervals for SM-2 buttons
  const previewInterval = (rating: SM2Rating) => {
    const res = calculateSM2(currentCard, rating);
    return res.nextReviewText;
  };

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      {/* Session Header / Cram Mode Toggle Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-slate-900/60 border border-slate-800 p-4 rounded-2xl backdrop-blur-sm">
        <div className="flex items-center gap-3">
          <span className="text-xs font-mono text-slate-400">
            Card {currentIndex + 1} of {activeCards.length}
          </span>
          <div className="h-4 w-[1px] bg-slate-800" />
          <span className={`text-[11px] font-bold uppercase tracking-wider px-2 py-0.5 rounded ${
            currentCard.format === 'cloze' 
              ? 'bg-purple-950/80 text-purple-400 border border-purple-800/60'
              : 'bg-blue-950/80 text-blue-400 border border-blue-800/60'
          }`}>
            {currentCard.format === 'cloze' ? 'Cloze Deletion' : 'Question & Answer'}
          </span>
        </div>

        {/* Cram Mode Banner & Setting */}
        <div className="flex items-center gap-2">
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
            <span>{isCramSession ? 'Cram Mode Active' : 'Enable Cram Mode'}</span>
          </button>

          {isCramSession && (
            <button
              onClick={() => setShowCramSettingsModal(true)}
              className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 transition-colors"
              title="Configure Cram SR behavior"
            >
              <Settings className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Main Flashcard Viewport */}
      <div className="bg-slate-900/80 border border-slate-800 rounded-3xl p-6 sm:p-10 shadow-2xl relative min-h-[380px] flex flex-col justify-between">
        {/* Front / Question */}
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

          {/* Back / Revealed Answer */}
          {isFlipped && (
            <div className="pt-6 border-t border-slate-800/80 space-y-4 animate-in fade-in duration-200">
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

              {/* Grounding Excerpt citation badge */}
              <div className="p-3 bg-slate-950/60 border border-slate-800/80 rounded-xl flex items-start justify-between gap-3 text-xs">
                <div className="space-y-1">
                  <span className="font-semibold text-slate-400 flex items-center gap-1.5">
                    <BookOpen className="w-3.5 h-3.5 text-emerald-400" />
                    Source Grounding Citation (Page {currentCard.grounding.pageNumber})
                  </span>
                  <p className="text-slate-300 italic">
                    "{currentCard.grounding.excerpt}"
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => onOpenDualViewer(currentCard)}
                  className="flex-shrink-0 px-2.5 py-1.5 rounded-lg bg-emerald-950/50 hover:bg-emerald-900/60 text-emerald-300 border border-emerald-800/60 font-semibold flex items-center gap-1 transition-colors"
                >
                  <Eye className="w-3.5 h-3.5" />
                  <span>Inspect PDF</span>
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Action Controls */}
        <div className="pt-8">
          {!isFlipped ? (
            <button
              onClick={() => setIsFlipped(true)}
              className="w-full py-4 rounded-2xl bg-slate-800 hover:bg-slate-700 text-slate-100 font-bold text-base transition-all active:scale-[0.99] border border-slate-700 shadow-lg"
            >
              Show Answer (Space)
            </button>
          ) : (
            <div className="space-y-3">
              <div className="grid grid-cols-4 gap-2 sm:gap-3">
                <button
                  onClick={() => handleRate(1)}
                  className="p-3 rounded-xl bg-red-950/40 hover:bg-red-900/60 border border-red-800/60 text-red-300 font-semibold text-xs sm:text-sm flex flex-col items-center gap-1 transition-colors"
                >
                  <span>Again</span>
                  <span className="text-[10px] font-mono text-red-400/80">
                    {isCramSession && !modifyScheduleInCram ? 'No change' : previewInterval(1)}
                  </span>
                </button>

                <button
                  onClick={() => handleRate(3)}
                  className="p-3 rounded-xl bg-amber-950/40 hover:bg-amber-900/60 border border-amber-800/60 text-amber-300 font-semibold text-xs sm:text-sm flex flex-col items-center gap-1 transition-colors"
                >
                  <span>Hard</span>
                  <span className="text-[10px] font-mono text-amber-400/80">
                    {isCramSession && !modifyScheduleInCram ? 'No change' : previewInterval(3)}
                  </span>
                </button>

                <button
                  onClick={() => handleRate(4)}
                  className="p-3 rounded-xl bg-blue-950/40 hover:bg-blue-900/60 border border-blue-800/60 text-blue-300 font-semibold text-xs sm:text-sm flex flex-col items-center gap-1 transition-colors"
                >
                  <span>Good</span>
                  <span className="text-[10px] font-mono text-blue-400/80">
                    {isCramSession && !modifyScheduleInCram ? 'No change' : previewInterval(4)}
                  </span>
                </button>

                <button
                  onClick={() => handleRate(5)}
                  className="p-3 rounded-xl bg-emerald-950/40 hover:bg-emerald-900/60 border border-emerald-800/60 text-emerald-300 font-semibold text-xs sm:text-sm flex flex-col items-center gap-1 transition-colors"
                >
                  <span>Easy</span>
                  <span className="text-[10px] font-mono text-emerald-400/80">
                    {isCramSession && !modifyScheduleInCram ? 'No change' : previewInterval(5)}
                  </span>
                </button>
              </div>

              {isCramSession && !modifyScheduleInCram && (
                <div className="text-center text-[11px] font-mono text-amber-400/80">
                  ⚡ Cram Mode: Reviewing without altering your long-term spaced repetition schedule.
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Cram Configuration Modal */}
      {showCramSettingsModal && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-3xl p-6 sm:p-8 max-w-md w-full shadow-2xl space-y-6">
            <div>
              <h3 className="text-lg font-bold text-slate-100 flex items-center gap-2">
                <Flame className="w-5 h-5 text-amber-400" />
                Configure Cram Session
              </h3>
              <p className="text-xs text-slate-400 mt-1">
                Confirmed requirement: Let the user choose whether cram mode alters the regular spaced-repetition schedule for each session.
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
                  <div className="text-sm font-semibold">Keep regular schedule intact (Recommended)</div>
                  <div className="text-xs text-slate-400 mt-0.5">
                    Cramming will not advance or reset your long-term intervals. Great for exam night revision.
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
                  <div className="text-sm font-semibold">Update regular spaced repetition schedule</div>
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
                Start Cram Session
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
