import React from 'react';
import { DocumentSection, CoverageMode } from '@jevdeck/contracts';
import { COVERAGE_CHOICES, Capability } from '../config/capabilities';
import {
  FileText,
  CheckSquare,
  Square,
  Layers,
  Sparkles,
  AlertCircle,
  Info,
  FileSearch,
} from 'lucide-react';
import { SourceUploader } from './SourceUploader';
import { UnavailablePanel } from './UnavailablePanel';
import { ReadReportPanel } from './ReadReportPanel';
import type { ParsedDocument } from '../lib/documentParser';
import { formatLabel, type ReadReport } from '../lib/readReport';
import { JobConcept, JobStatus, StoredDocumentSummary } from '../lib/api';
import { GenerationResult } from './GenerationResult';
import { Database, Loader2, AlertCircle as AlertIcon, CheckCircle2 } from 'lucide-react';

/**
 * The outline as a flat list of rows, each with how deep it sits in the tree.
 *
 * The tree is flattened rather than drawn from its top level, because a document's subsections are
 * selectable material too: a screen that listed only chapters would hide most of what a run can be
 * pointed at, and a subsection that cannot be seen cannot be excluded either.
 */
function flattenSections(
  sections: DocumentSection[],
  depth = 0
): Array<{ section: DocumentSection; depth: number }> {
  return sections.flatMap(section => [
    { section, depth },
    ...flattenSections(section.subsections ?? [], depth + 1),
  ]);
}

/** Indentation by depth, from classes the stylesheet already defines. */
const DEPTH_INDENT = ['', 'pl-8', 'pl-12', 'pl-16'] as const;

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
  /** Whether the source document text is available to ground generation. */
  hasDocumentText: boolean;
  onDocumentUploaded: (document: ParsedDocument) => void;
  /** Whether provider-backed generation exists on this installation. */
  generationCapability: Capability;
  /** Whether uploaded documents are stored server-side. */
  storageCapability: Capability;
  /** True when the loaded document and cards are synthetic demo content. */
  isDemo: boolean;
  /** Documents this account already has on the server, straight from the API. */
  storedDocuments: StoredDocumentSummary[];
  /** The stored document currently loaded, when the local view came from the server. */
  activeDocumentId: string | null;
  onOpenStoredDocument: (id: string) => void;
  storageBusy: boolean;
  /** Confirmation that an upload was persisted, or why it was not. */
  storageNotice: string | null;
  storageError: string | null;
  /** The generation job being followed, exactly as the API reports it. */
  jobStatus: JobStatus | null;
  /** The concept inventory of that job, with what was decided about each concept. */
  jobConcepts: JobConcept[];
  /** Why generation could not be started or did not finish. */
  generationError: string | null;
  /** Stops the run being followed, discarding what it had not stored. */
  onCancelGeneration: () => void;
  /** Stops the run being followed, keeping its progress so it can be resumed. */
  onPauseGeneration: () => void;
  /** Queues a stopped run again, to continue from its stored progress. */
  onResumeGeneration: () => void;
  /**
   * Offered only when the server has said the run cannot be continued: a cancelled run, or one
   * whose stored progress does not apply to it. Starting again is a new run with its own spend.
   */
  onStartNewRun?: () => void;
  /** True while a pause, resume or cancel request is in flight. */
  generationActionBusy: boolean;
  /** What a pause or resume request answered when it was not the plain success case. */
  generationActionNotice: string | null;
  /**
   * What this account has spent this period, against its limit.
   *
   * Read from the server's ledger, and `null` when no figure could be read. It states the spend
   * rather than projecting what a run will cost.
   */
  budgetNotice: string | null;
  /**
   * What the open document's reader actually read, or `null` when no document is open.
   *
   * Built from the parse for a fresh upload and from the stored rows for a reopened document, so
   * the account of the read is the same either way — and always the reader's, never a projection.
   */
  readReport: ReadReport | null;
}

/**
 * Document ingestion and generation screen.
 *
 * Shows selected sections and coverage mode — and nothing that projects a result. There is
 * deliberately no card-count, study-time or cost estimate: the application cannot know how
 * many concepts a source contains, and the confirmed requirement is that users see selected
 * sections and coverage mode only. See `SPEC.md` §2.1 and §2.2.
 */
/** Compact provenance for a stored document, so two similarly named files stay distinct. */
function describeStored(document: StoredDocumentSummary): string {
  const hash = document.contentHash ? `${document.contentHash.slice(0, 10)}…` : 'no hash';
  const stored = new Date(document.createdAt);
  const when = Number.isNaN(stored.getTime())
    ? 'date unknown'
    : stored.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  return `${when} · sha256 ${hash}`;
}

export const GenerationView: React.FC<Props> = ({
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
  hasDocumentText,
  onDocumentUploaded,
  generationCapability,
  storageCapability,
  isDemo,
  storedDocuments,
  activeDocumentId,
  onOpenStoredDocument,
  storageBusy,
  storageNotice,
  storageError,
  jobStatus,
  jobConcepts,
  generationError,
  onCancelGeneration,
  onPauseGeneration,
  onResumeGeneration,
  onStartNewRun,
  generationActionBusy,
  generationActionNotice,
  budgetNotice,
  readReport,
}) => {
  const sectionRows = flattenSections(sections);
  const selectedCount = sectionRows.filter(row => row.section.selected).length;
  const hasDocument = documentName.length > 0;
  const activeChoice = COVERAGE_CHOICES.find(c => c.value === coverageMode) ?? COVERAGE_CHOICES[0];
  const canGenerate = selectedCount > 0 && hasDocumentText;

  return (
    <div className="space-y-6">
      {/* Upload Zone */}
      <SourceUploader onDocumentParsed={onDocumentUploaded} isProcessing={isGenerating} />

      {!storageCapability.available && (
        <UnavailablePanel
          capability={storageCapability}
          blockedAction="Uploading a document is supported; keeping it is not."
        />
      )}

      {storageCapability.available && (
        <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-5 sm:p-6 shadow-xl space-y-4">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-bold text-slate-200 flex items-center gap-2">
              <Database className="w-4 h-4 text-cyan-400" />
              Stored documents
              {storageBusy && <Loader2 className="w-3.5 h-3.5 animate-spin text-slate-500" />}
            </h2>
            {storedDocuments.length > 0 && (
              <span className="text-xs text-slate-500 font-mono">{storedDocuments.length} stored</span>
            )}
          </div>

          {storageError && (
            <div className="flex items-start gap-2 text-xs text-red-300 bg-red-950/30 border border-red-900/50 rounded-xl p-3">
              <AlertIcon className="w-4 h-4 flex-shrink-0 mt-0.5" />
              <span>{storageError}</span>
            </div>
          )}

          {storageNotice && !storageError && (
            <div className="flex items-start gap-2 text-xs text-emerald-300 bg-emerald-950/30 border border-emerald-900/50 rounded-xl p-3">
              <CheckCircle2 className="w-4 h-4 flex-shrink-0 mt-0.5" />
              <span>{storageNotice}</span>
            </div>
          )}

          {storedDocuments.length === 0 ? (
            <p className="text-xs text-slate-500 leading-relaxed">
              Nothing is stored for this account yet. An uploaded document is written here with
              its page text and section tree, and is still available after a reload or a restart.
            </p>
          ) : (
            <div className="divide-y divide-slate-800/70 rounded-xl border border-slate-800/80 overflow-hidden">
              {storedDocuments.map(document => {
                const isActive = document.id === activeDocumentId;
                return (
                  <div
                    key={document.id}
                    className={`px-4 py-3 flex items-center justify-between gap-4 ${
                      isActive ? 'bg-cyan-950/20' : 'bg-slate-950/20'
                    }`}
                  >
                    <div className="min-w-0 space-y-0.5">
                      <div className="text-sm font-medium text-slate-200 truncate">
                        {document.name}
                      </div>
                      <div className="text-[11px] font-mono text-slate-500">
                        {/* Readable pages beside the total: a document of scans has fewer pages
                            cards can come from, and the list must not hide that. */}
                        {formatLabel(document.sourceFormat)} · {document.pageCount} pages ·{' '}
                        {document.textPages} readable
                        {document.unextractedPages > 0
                          ? ` · ${document.unextractedPages} unread`
                          : ''}
                        {document.mediaCount > 0 ? ` · ${document.mediaCount} images` : ''}
                      </div>
                      <div className="text-[11px] font-mono text-slate-500">
                        {describeStored(document)}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => onOpenStoredDocument(document.id)}
                      disabled={storageBusy || isActive}
                      className="flex-shrink-0 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors disabled:opacity-60 bg-slate-800 hover:bg-slate-700 text-slate-200"
                    >
                      {isActive ? 'Loaded' : 'Open'}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Document Meta */}
      {hasDocument && (
        <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-6 backdrop-blur-sm shadow-xl">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div className="flex items-start gap-4">
              <div className="p-3 bg-emerald-950/80 border border-emerald-800/60 text-emerald-400 rounded-xl">
                <FileText className="w-6 h-6" />
              </div>
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h1 className="text-xl font-bold text-slate-100">{documentName}</h1>
                  <span className="text-xs px-2 py-0.5 rounded-full bg-slate-800 border border-slate-700 text-slate-300">
                    {readReport ? readReport.formatLabel : 'Document'} ({pageCount} pages)
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
                  Select the chapters or subsections you want covered, then choose how much of
                  them to cover.
                </p>
              </div>
            </div>

            {sections.length > 0 && (
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
            )}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left Column: Section Selector */}
        <div className="lg:col-span-7 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-bold text-slate-200 flex items-center gap-2">
              <Layers className="w-4 h-4 text-emerald-400" />
              Document Sections & Table of Contents
            </h2>
            {sectionRows.length > 0 && (
              <span className="text-xs text-slate-400">
                {selectedCount} of {sectionRows.length} sections selected
              </span>
            )}
          </div>

          {sectionRows.length === 0 ? (
            <div className="bg-slate-900/40 border border-dashed border-slate-800 rounded-2xl p-10 text-center space-y-2">
              <FileSearch className="w-8 h-8 text-slate-600 mx-auto" />
              <p className="text-sm font-semibold text-slate-300">No document loaded</p>
              <p className="text-xs text-slate-500 max-w-sm mx-auto">
                Upload a document above, or paste text. JevDeck reads its text and its outline in
                your browser, then lists the sections it found and reports what it could not read.
              </p>
            </div>
          ) : (
            <div className="bg-slate-900/40 border border-slate-800/80 rounded-2xl overflow-hidden divide-y divide-slate-800/60">
              {sectionRows.map(({ section, depth }) => {
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

                    <div
                      className={`flex-1 ${
                        DEPTH_INDENT[Math.min(depth, DEPTH_INDENT.length - 1)]
                      } ${isChapter ? 'font-semibold text-slate-200' : 'text-slate-300'}`}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-sm">{section.title}</span>
                        <span className="text-xs font-mono text-slate-500 flex-shrink-0">
                          pp. {section.pageStart}-{section.pageEnd}
                        </span>
                      </div>

                      <div className="flex items-center gap-3 mt-1 text-xs text-slate-500 font-mono">
                        <span>{section.wordCount.toLocaleString()} words</span>
                        <span>•</span>
                        <span>{section.pageEnd - section.pageStart + 1} pages</span>
                        {isChapter ? (
                          <span className="text-emerald-500/80 font-sans font-medium text-[11px] bg-emerald-950/50 px-1.5 py-0.2 rounded border border-emerald-900/60">
                            Chapter
                          </span>
                        ) : (
                          depth > 0 && (
                            <span className="text-slate-400/90 font-sans font-medium text-[11px] bg-slate-800/60 px-1.5 py-0.2 rounded border border-slate-700/70">
                              Subsection
                            </span>
                          )
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {generationCapability.available && (
            <div className="flex items-start gap-2 p-3 bg-slate-900/60 border border-slate-800/80 rounded-xl text-xs text-slate-400">
              <Info className="w-4 h-4 text-cyan-400 flex-shrink-0 mt-0.5" />
              <span>
                Card format is chosen automatically from the content of each passage, not from
                the section title. Mechanistic and causal statements become Q&amp;A cards;
                definitions and measured values become cloze deletions.
              </span>
            </div>
          )}
        </div>

        {/* Right Column: Coverage Mode & Generation */}
        <div className="lg:col-span-5 space-y-6">
          <div className="bg-slate-900/70 border border-slate-800 rounded-2xl p-6 shadow-xl space-y-6 sticky top-24">
            <div>
              <h2 className="text-base font-bold text-slate-100 flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-emerald-400" />
                Coverage
              </h2>
              <p className="text-xs text-slate-400 mt-1">
                How much of the selected sections to cover. JevDeck decides how many cards the
                concepts in that material warrant.
              </p>
            </div>

            {/* The two agreed coverage choices */}
            <div className="space-y-2">
              <div className="grid grid-cols-2 gap-2">
                {COVERAGE_CHOICES.map(choice => (
                  <button
                    key={choice.value}
                    type="button"
                    onClick={() => onCoverageModeChange(choice.value)}
                    aria-pressed={coverageMode === choice.value}
                    className={`py-2.5 px-2.5 rounded-xl text-xs font-semibold border transition-all text-center ${
                      coverageMode === choice.value
                        ? 'bg-emerald-500 text-slate-950 border-emerald-400 shadow-md shadow-emerald-500/20 font-bold'
                        : 'bg-slate-800/80 text-slate-300 border-slate-700 hover:bg-slate-700'
                    }`}
                  >
                    {choice.label}
                  </button>
                ))}
              </div>
              <p className="text-[11px] text-slate-500 italic mt-1">{activeChoice.description}</p>
            </div>

            <div className="space-y-3 pt-2">
              {generationCapability.available ? (
                <button
                  type="button"
                  disabled={!canGenerate || isGenerating}
                  onClick={onStartGeneration}
                  className={`w-full py-3.5 px-4 rounded-xl font-bold flex items-center justify-center gap-2 text-sm shadow-lg transition-all ${
                    !canGenerate || isGenerating
                      ? 'bg-slate-800 text-slate-500 cursor-not-allowed border border-slate-700'
                      : 'bg-gradient-to-r from-emerald-500 to-teal-600 hover:from-emerald-400 hover:to-teal-500 text-slate-950 shadow-emerald-500/25 active:scale-[0.98]'
                  }`}
                >
                  {isGenerating ? (
                    <>
                      <div className="w-4 h-4 border-2 border-slate-950 border-t-transparent rounded-full animate-spin" />
                      <span>Reading source text…</span>
                    </>
                  ) : (
                    <>
                      <Sparkles className="w-4 h-4" />
                      <span>{isDemo ? 'Generate Demo Cards (local simulator)' : 'Generate Cards'}</span>
                    </>
                  )}
                </button>
              ) : (
                <UnavailablePanel
                  capability={generationCapability}
                  blockedAction="Generating cards is disabled on this installation."
                />
              )}

              {selectedCount === 0 && (
                <div className="flex items-center gap-2 text-xs text-amber-400/90 bg-amber-950/30 p-2.5 rounded-lg border border-amber-900/40">
                  <AlertCircle className="w-4 h-4 flex-shrink-0" />
                  <span>Select at least one document section above to start card generation.</span>
                </div>
              )}

              {!hasDocumentText && (
                <div className="flex items-center gap-2 text-xs text-amber-400/90 bg-amber-950/30 p-2.5 rounded-lg border border-amber-900/40">
                  <AlertCircle className="w-4 h-4 flex-shrink-0" />
                  <span>
                    Upload a document first — cards are generated from the text that was read, not
                    from a summary of the file.
                  </span>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {readReport && <ReadReportPanel report={readReport} />}

      {budgetNotice && (
        <div className="rounded-2xl border border-slate-800 bg-slate-900/40 px-4 py-3 text-[11px] text-slate-400">
          {budgetNotice}
        </div>
      )}

      {/* What the run really did: state, coverage counts and the concept inventory. */}
      {(jobStatus || generationError) && (
        <GenerationResult
          jobStatus={jobStatus}
          concepts={jobConcepts}
          error={generationError}
          onCancel={onCancelGeneration}
          onPause={onPauseGeneration}
          onResume={onResumeGeneration}
          onStartNewRun={onStartNewRun}
          busy={generationActionBusy}
          actionNotice={generationActionNotice}
        />
      )}
    </div>
  );
};
