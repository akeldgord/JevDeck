import React from 'react';
import { Flashcard } from '@jevdeck/contracts';
import { 
  X, 
  BookOpen, 
  Sparkles,
  CheckCircle2,
  Bookmark
} from 'lucide-react';

interface Props {
  card: Flashcard | null;
  onClose: () => void;
}

export const DualGroundingViewer: React.FC<Props> = ({ card, onClose }) => {
  if (!card) return null;

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-md flex items-center justify-center p-2 sm:p-6 animate-in fade-in duration-150">
      <div className="bg-slate-900 border border-slate-800 rounded-3xl w-full max-w-6xl h-[90vh] flex flex-col shadow-2xl overflow-hidden">
        {/* Modal Top Bar */}
        <div className="px-6 py-4 border-b border-slate-800 flex items-center justify-between bg-slate-950/60">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
              <BookOpen className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="font-bold text-slate-100 text-sm sm:text-base">
                  Dual Grounding Inspection
                </h3>
                <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-950 border border-emerald-800 text-emerald-400 font-mono">
                  {Math.round(card.grounding.confidenceScore * 100)}% Verbatim Match
                </span>
              </div>
              <p className="text-xs text-slate-400">
                {card.grounding.sectionTitle} • Page {card.grounding.pageNumber}
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-2 rounded-xl hover:bg-slate-800 text-slate-400 hover:text-slate-100 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Dual Panels: Left = Excerpt & Card context, Right = Simulated Original Page PDF Viewer */}
        <div className="flex-1 grid grid-cols-1 lg:grid-cols-12 overflow-hidden">
          {/* Left Panel: Verified Excerpt & Card Synthesis */}
          <div className="lg:col-span-5 p-6 border-r border-slate-800/80 overflow-y-auto space-y-6 bg-slate-950/30">
            <div>
              <span className="text-xs font-bold uppercase tracking-wider text-slate-400">
                Extracted Source Excerpt
              </span>
              <div className="mt-2 p-4 rounded-2xl bg-slate-900 border border-slate-800 text-slate-200 text-sm leading-relaxed relative">
                <div className="absolute top-3 right-3 text-slate-600">
                  <Bookmark className="w-4 h-4 text-emerald-400/60" />
                </div>
                "{card.grounding.excerpt}"
              </div>
            </div>

            <div>
              <span className="text-xs font-bold uppercase tracking-wider text-slate-400">
                Synthesized Flashcard
              </span>
              <div className="mt-2 p-4 rounded-2xl bg-emerald-950/20 border border-emerald-500/30 space-y-3">
                <div className="text-xs font-bold uppercase text-emerald-400">
                  {card.format === 'qa' ? 'Question & Answer' : 'Cloze Deletion'}
                </div>
                {card.format === 'qa' ? (
                  <>
                    <div className="text-sm font-semibold text-slate-100">
                      {card.question}
                    </div>
                    <div className="text-sm text-emerald-200 border-t border-emerald-900/60 pt-2">
                      {card.answer}
                    </div>
                  </>
                ) : (
                  <div className="text-sm text-slate-200">
                    {card.clozeText}
                  </div>
                )}
              </div>
            </div>

            {card.explanation && (
              <div className="text-xs text-slate-400 bg-slate-900/60 p-3.5 rounded-xl border border-slate-800">
                <span className="font-semibold text-slate-300">Contextual Nuance: </span>
                {card.explanation}
              </div>
            )}
          </div>

          {/* Right Panel: Synchronized Original-Page PDF Viewer */}
          <div className="lg:col-span-7 bg-slate-950 flex flex-col overflow-hidden">
            <div className="px-4 py-2 border-b border-slate-800 flex items-center justify-between text-xs text-slate-400 bg-slate-900/50">
              <span className="font-mono">PDF Viewer: Page {card.grounding.pageNumber}</span>
              <div className="flex items-center gap-3">
                <span className="text-[11px] bg-slate-800 px-2 py-0.5 rounded text-slate-300">100% Zoom</span>
                <span className="text-emerald-400 flex items-center gap-1 font-semibold">
                  <CheckCircle2 className="w-3.5 h-3.5" /> Highlighting Active Excerpt
                </span>
              </div>
            </div>

            {/* Simulated Document Page with Realistic Academic Typography and Highlight */}
            <div className="flex-1 overflow-y-auto p-6 sm:p-10 flex justify-center bg-slate-950">
              <div className="bg-slate-900 text-slate-300 border border-slate-800 rounded-xl shadow-2xl p-8 sm:p-12 max-w-2xl w-full text-xs sm:text-sm font-serif leading-relaxed relative">
                {/* Academic Header */}
                <div className="border-b border-slate-800 pb-3 mb-6 flex justify-between text-[11px] font-mono text-slate-500 uppercase tracking-widest">
                  <span>Principles of Neural Science • Section 1</span>
                  <span>Page {card.grounding.pageNumber}</span>
                </div>

                <p className="mb-4 text-slate-400">
                  Synaptic mechanisms in the central nervous system demand exquisite temporal regulation. Active neurotransmitter vesicles congregate at the presynaptic grid, ready for calcium-triggered mobilization.
                </p>

                {/* Highlighted Excerpt Region */}
                <div className="relative my-4 p-3 rounded-lg bg-emerald-500/15 border-l-4 border-emerald-400 text-slate-100 font-sans shadow-sm ring-1 ring-emerald-500/20">
                  <div className="text-[10px] font-mono uppercase tracking-wider text-emerald-400 font-bold mb-1 flex items-center gap-1">
                    <Sparkles className="w-3 h-3" /> Grounded Passage Target
                  </div>
                  {card.grounding.excerpt}
                </div>

                <p className="mt-4 text-slate-400">
                  Subsequent downstream cascade elements recruit phosphorylation kinases to maintain equilibrium. When postsynaptic densities mature, morphological changes stabilize synaptic transmission efficiency across long timescales.
                </p>

                <div className="mt-12 pt-4 border-t border-slate-800 text-[10px] font-mono text-slate-600 text-center">
                  --- End of Page {card.grounding.pageNumber} Document Render ---
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
