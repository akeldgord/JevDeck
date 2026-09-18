import React from 'react';
import { 
  DocumentSection, 
  CoverageMode, 
  WorkloadEstimate 
} from '@jevdeck/contracts';
import { estimateWorkload } from '@jevdeck/generation';
import { 
  FileText, 
  CheckSquare, 
  Square, 
  Clock, 
  Layers, 
  DollarSign, 
  Sparkles, 
  AlertCircle,
  FileCheck2,
  Info
} from 'lucide-react';
import { PdfUploader } from './PdfUploader';
import { ParsedPdfResult } from '../lib/pdfParser';

interface Props {
  sections: DocumentSection[];
  onToggleSection: (id: string) => void;
  onSelectAll: (select: boolean) => void;
  coverageMode: CoverageMode;
  onCoverageModeChange: (mode: CoverageMode) => void;
  onStartGeneration: () => void;
  isGenerating: boolean;
  documentName: string;
  pageCount: number;
  hasCustomToc: boolean;
  onDocumentUploaded: (result: ParsedPdfResult) => void;
}

export const SectionSelectorAndEstimator: React.FC<Props> = ({
  sections,
  onToggleSection,
  onSelectAll,
  coverageMode,
  onCoverageModeChange,
  onStartGeneration,
  isGenerating,
  documentName,
  pageCount,
  hasCustomToc,
  onDocumentUploaded,
}) => {
  const estimate: WorkloadEstimate = estimateWorkload(sections, coverageMode);
  const selectedCount = sections.filter(s => s.selected).length;

  return (
    <div className="space-y-6">
      {/* Upload Zone */}
      <PdfUploader
        onDocumentParsed={onDocumentUploaded}
        isProcessing={isGenerating}
      />

      {/* Top Banner / Document Meta */}
      <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-6 backdrop-blur-sm shadow-xl">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="flex items-start gap-4">
            <div className="p-3 bg-emerald-950/80 border border-emerald-800/60 text-emerald-400 rounded-xl">
              <FileText className="w-6 h-6" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-xl font-bold text-slate-100">{documentName}</h1>
                <span className="text-xs px-2 py-0.5 rounded-full bg-slate-800 border border-slate-700 text-slate-300">
                  PDF ({pageCount} pages)
                </span>
                {hasCustomToc ? (
                  <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-950 border border-emerald-800 text-emerald-400 font-medium">
                    TOC Extracted
                  </span>
                ) : (
                  <span className="text-xs px-2 py-0.5 rounded-full bg-slate-800 border border-slate-700 text-slate-400">
                    Auto-Segmented
                  </span>
                )}
              </div>
              <p className="text-sm text-slate-400 mt-1">
                Dense textbook document ingested. Select target chapters or subsections to balance precision with study workload.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 self-end md:self-center">
            <button
              onClick={() => onSelectAll(true)}
              className="text-xs px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 transition-colors"
            >
              Select All
            </button>
            <button
              onClick={() => onSelectAll(false)}
              className="text-xs px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 transition-colors"
            >
              Clear
            </button>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left Column: Section Selector */}
        <div className="lg:col-span-7 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-bold text-slate-200 flex items-center gap-2">
              <Layers className="w-4 h-4 text-emerald-400" />
              Document Sections & Table of Contents
            </h2>
            <span className="text-xs text-slate-400">
              {selectedCount} of {sections.length} sections selected
            </span>
          </div>

          <div className="bg-slate-900/40 border border-slate-800/80 rounded-2xl overflow-hidden divide-y divide-slate-800/60">
            {sections.map((section) => {
              const isChapter = section.level === 1;
              return (
                <div
                  key={section.id}
                  onClick={() => onToggleSection(section.id)}
                  className={`p-4 cursor-pointer transition-colors flex items-start gap-3 select-none ${
                    section.selected
                      ? 'bg-emerald-950/20 hover:bg-emerald-950/30'
                      : 'hover:bg-slate-800/30 text-slate-400'
                  }`}
                >
                  <button
                    type="button"
                    className="mt-0.5 text-emerald-400 hover:text-emerald-300 transition-colors"
                  >
                    {section.selected ? (
                      <CheckSquare className="w-5 h-5 text-emerald-400" />
                    ) : (
                      <Square className="w-5 h-5 text-slate-600" />
                    )}
                  </button>

                  <div className={`flex-1 ${isChapter ? 'font-semibold text-slate-200' : 'text-slate-300 pl-2'}`}>
                    <div className="flex items-center justify-between">
                      <span className="text-sm">{section.title}</span>
                      <span className="text-xs font-mono text-slate-500">
                        pp. {section.pageStart}-{section.pageEnd}
                      </span>
                    </div>

                    <div className="flex items-center gap-3 mt-1 text-xs text-slate-500 font-mono">
                      <span>{section.wordCount.toLocaleString()} words</span>
                      <span>•</span>
                      <span>{section.pageEnd - section.pageStart + 1} pages</span>
                      {isChapter && (
                        <span className="text-emerald-500/80 font-sans font-medium text-[11px] bg-emerald-950/50 px-1.5 py-0.2 rounded border border-emerald-900/60">
                          Primary Topic
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="flex items-center gap-2 p-3 bg-slate-900/60 border border-slate-800/80 rounded-xl text-xs text-slate-400">
            <Info className="w-4 h-4 text-cyan-400 flex-shrink-0" />
            <span>
              Format selection is completely automated: mechanistic & causal concepts automatically yield Q&A cards; definitions and values yield Cloze deletions.
            </span>
          </div>
        </div>

        {/* Right Column: Pre-Generation Workload Estimator & Coverage Mode */}
        <div className="lg:col-span-5 space-y-6">
          <div className="bg-slate-900/70 border border-slate-800 rounded-2xl p-6 shadow-xl space-y-6 sticky top-24">
            <div>
              <h2 className="text-base font-bold text-slate-100 flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-emerald-400" />
                Pre-Generation Workload Estimator
              </h2>
              <p className="text-xs text-slate-400 mt-1">
                Estimated coverage and recall load before generating cards.
              </p>
            </div>

            {/* Coverage Depth Selector */}
            <div className="space-y-2">
              <label className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                Coverage Depth Mode
              </label>
              <div className="grid grid-cols-3 gap-2">
                {(['essential', 'comprehensive', 'indepth'] as CoverageMode[]).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => onCoverageModeChange(mode)}
                    className={`py-2 px-2.5 rounded-xl text-xs font-semibold capitalize border transition-all text-center ${
                      coverageMode === mode
                        ? 'bg-emerald-500 text-slate-950 border-emerald-400 shadow-md shadow-emerald-500/20 font-bold'
                        : 'bg-slate-800/80 text-slate-300 border-slate-700 hover:bg-slate-700'
                    }`}
                  >
                    {mode}
                  </button>
                ))}
              </div>
              <p className="text-[11px] text-slate-500 italic mt-1">
                {coverageMode === 'essential' && 'High-yield core definitions and key causal principles (~1 card / 400 words).'}
                {coverageMode === 'comprehensive' && 'Balanced textbook coverage covering all primary concepts (~1 card / 200 words).'}
                {coverageMode === 'indepth' && 'Exhaustive cards for dense boards, formulas, and clinical nuances (~1 card / 120 words).'}
              </p>
            </div>

            {/* Metrics Breakdown Grid */}
            <div className="grid grid-cols-2 gap-3 pt-2">
              <div className="bg-slate-950/60 border border-slate-800/80 rounded-xl p-3.5">
                <div className="flex items-center gap-2 text-slate-400 text-xs font-medium">
                  <FileCheck2 className="w-3.5 h-3.5 text-emerald-400" />
                  Estimated Cards
                </div>
                <div className="text-2xl font-extrabold text-slate-100 font-mono mt-1">
                  ~{estimate.estimatedCards}
                </div>
                <div className="text-[10px] text-slate-500 mt-0.5">Automated Q&A + Cloze</div>
              </div>

              <div className="bg-slate-950/60 border border-slate-800/80 rounded-xl p-3.5">
                <div className="flex items-center gap-2 text-slate-400 text-xs font-medium">
                  <Clock className="w-3.5 h-3.5 text-cyan-400" />
                  Est. Study Time
                </div>
                <div className="text-2xl font-extrabold text-slate-100 font-mono mt-1">
                  {estimate.estimatedStudyTimeMinutes} <span className="text-xs font-normal text-slate-400">min</span>
                </div>
                <div className="text-[10px] text-slate-500 mt-0.5">First complete pass</div>
              </div>

              <div className="bg-slate-950/60 border border-slate-800/80 rounded-xl p-3.5">
                <div className="flex items-center gap-2 text-slate-400 text-xs font-medium">
                  <Layers className="w-3.5 h-3.5 text-indigo-400" />
                  Words & Pages
                </div>
                <div className="text-base font-bold text-slate-200 font-mono mt-1">
                  {estimate.totalWords.toLocaleString()} <span className="text-xs font-normal text-slate-500">words</span>
                </div>
                <div className="text-[10px] text-slate-500 mt-0.5">{estimate.pageCount} active pages</div>
              </div>

              <div className="bg-slate-950/60 border border-slate-800/80 rounded-xl p-3.5">
                <div className="flex items-center gap-2 text-slate-400 text-xs font-medium">
                  <DollarSign className="w-3.5 h-3.5 text-amber-400" />
                  Est. API Spend
                </div>
                <div className="text-base font-bold text-emerald-400 font-mono mt-1">
                  ${estimate.estimatedCostUsd.toFixed(2)}
                </div>
                <div className="text-[10px] text-slate-500 mt-0.5 font-mono">~{estimate.estimatedTokens.toLocaleString()} tokens</div>
              </div>
            </div>

            {/* Generation CTA Button */}
            <div className="space-y-3 pt-2">
              <button
                type="button"
                disabled={selectedCount === 0 || isGenerating}
                onClick={onStartGeneration}
                className={`w-full py-3.5 px-4 rounded-xl font-bold flex items-center justify-center gap-2 text-sm shadow-lg transition-all ${
                  selectedCount === 0 || isGenerating
                    ? 'bg-slate-800 text-slate-500 cursor-not-allowed border border-slate-700'
                    : 'bg-gradient-to-r from-emerald-500 to-teal-600 hover:from-emerald-400 hover:to-teal-500 text-slate-950 shadow-emerald-500/25 active:scale-[0.98]'
                }`}
              >
                {isGenerating ? (
                  <>
                    <div className="w-4 h-4 border-2 border-slate-950 border-t-transparent rounded-full animate-spin" />
                    <span>Extracting Concepts & Synthesizing Cards...</span>
                  </>
                ) : (
                  <>
                    <Sparkles className="w-4 h-4" />
                    <span>Generate Grounded Cards ({estimate.estimatedCards} Cards)</span>
                  </>
                )}
              </button>

              {selectedCount === 0 && (
                <div className="flex items-center gap-2 text-xs text-amber-400/90 bg-amber-950/30 p-2.5 rounded-lg border border-amber-900/40">
                  <AlertCircle className="w-4 h-4 flex-shrink-0" />
                  <span>Select at least one document section above to start card generation.</span>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
