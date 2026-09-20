import React from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Layers,
  ListTree,
  Pause,
  Play,
  Square,
  XCircle,
} from 'lucide-react';
import { JobConcept, JobStatus } from '../lib/api';

interface Props {
  jobStatus: JobStatus | null;
  concepts: JobConcept[];
  error: string | null;
  /** Stops the run being followed, discarding it. Absent when there is nothing to stop. */
  onCancel?: () => void;
  /** Stops the run being followed, keeping its progress so it can be resumed. */
  onPause?: () => void;
  /** Queues a stopped run again, to continue from its stored progress. */
  onResume?: () => void;
  /** True while a stop or resume request is in flight, so a control cannot be pressed twice. */
  busy?: boolean;
  /** What the last pause or resume request answered, when it was not the plain success case. */
  actionNotice?: string | null;
}

/** Human wording for each coverage decision. The codes themselves are internal. */
const DECISION_TEXT: Record<string, string> = {
  included_central: 'Included — central to the material',
  included_eligible: 'Included — eligible under this coverage',
  excluded_secondary_high_yield: 'Left out — secondary detail, high-yield coverage',
  excluded_out_of_scope: 'Left out — outside the selected sections',
  excluded_not_in_source: 'Discarded — not found in the stored source',
  excluded_duplicate: 'Left out — duplicate of another concept',
  excluded_no_grounded_card: 'Left out — no card could be grounded in the source',
  excluded_validation_failed: 'Left out — the card it produced failed validation',
};

/** Wording for the reasons a card was withheld, keyed by the code the pipeline recorded. */
const WITHHELD_TEXT: Record<string, string> = {
  concept_not_answered: 'the provider returned no card',
  card_format_mismatch: 'the card used the wrong format',
  empty_cloze: 'a cloze card had nothing to hide',
  ungrounded_excerpt: 'the cited passage is not in the stored source',
  unsupported_claim: 'the claim is not supported by the cited page',
  duplicate_card: 'it duplicated another card',
  repair_failed: 'the retry still did not produce a usable card',
};

function describeDecision(code: string): string {
  return DECISION_TEXT[code] ?? code.replace(/_/g, ' ');
}

function describeWithheld(code: string): string {
  return WITHHELD_TEXT[code] ?? code.replace(/_/g, ' ');
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-950/40 px-3 py-2">
      <div className="text-[10px] font-mono uppercase tracking-wide text-slate-500">{label}</div>
      <div className="text-sm font-semibold text-slate-200">{value}</div>
    </div>
  );
}

/**
 * What a generation run actually did.
 *
 * Every number here is read from the job record. Nothing is projected and nothing is estimated:
 * an empty run says it found nothing, a failed run says why, and a concept that was left out shows
 * the decision that left it out.
 */
export const GenerationResult: React.FC<Props> = ({
  jobStatus,
  concepts,
  error,
  onCancel,
  onPause,
  onResume,
  busy = false,
  actionNotice = null,
}) => {
  // A run stopped on purpose reads differently from one that broke, and the recorded code is what
  // tells them apart — the state alone does not, because a cancelled run is terminal too.
  const wasCancelled = jobStatus?.job.errorCode === 'cancelled_by_user';
  const wasPaused = jobStatus?.job.state === 'paused' || jobStatus?.job.errorCode === 'paused_by_user';
  // A checkpoint is what makes a stopped run continuable: without one there is nothing to resume
  // from, and the server refuses rather than silently starting the run again.
  const canResume = Boolean(
    onResume && jobStatus?.job.hasCheckpoint && jobStatus.job.state !== 'completed'
  );

  if (error) {
    return (
      <div
        className={`bg-slate-900/70 border rounded-2xl p-6 space-y-3 ${
          wasCancelled || wasPaused ? 'border-slate-800' : 'border-red-900/60'
        }`}
      >
        <h2
          className={`text-sm font-bold flex items-center gap-2 ${
            wasCancelled || wasPaused ? 'text-slate-200' : 'text-red-200'
          }`}
        >
          {wasPaused ? (
            <Pause className="w-4 h-4" />
          ) : wasCancelled ? (
            <Square className="w-4 h-4" />
          ) : (
            <AlertTriangle className="w-4 h-4" />
          )}
          {wasPaused
            ? 'Generation is paused'
            : wasCancelled
              ? 'Generation was cancelled'
              : 'Generation did not finish'}
        </h2>
        <p
          className={`text-xs leading-relaxed ${
            wasCancelled || wasPaused ? 'text-slate-400' : 'text-red-200/90'
          }`}
        >
          {error}
        </p>

        {canResume && (
          <div className="space-y-2">
            <button
              type="button"
              onClick={onResume}
              disabled={busy}
              className="inline-flex items-center gap-2 rounded-lg border border-emerald-800 bg-emerald-950/50 px-3 py-1.5 text-xs font-semibold text-emerald-200 transition-colors hover:bg-emerald-950 disabled:opacity-60"
            >
              <Play className="w-3.5 h-3.5" />
              {busy ? 'Resuming…' : 'Resume run'}
            </button>
            <p className="text-[11px] text-slate-500">
              Resuming continues from the concepts and cards this run had already paid for, rather
              than generating them again.
            </p>
          </div>
        )}

        {actionNotice && <p className="text-[11px] text-amber-300/90">{actionNotice}</p>}
      </div>
    );
  }

  if (!jobStatus) return null;

  const { job, omissions, coverageSummary } = jobStatus;
  const running = job.state === 'pending' || job.state === 'processing';

  const included = concepts.filter(concept => concept.decision.startsWith('included'));
  const excluded = concepts.filter(concept => !concept.decision.startsWith('included'));

  return (
    <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-5 sm:p-6 shadow-xl space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h2 className="text-sm font-bold text-slate-200 flex items-center gap-2">
            <Layers className="w-4 h-4 text-cyan-400" />
            Generation run
          </h2>
          <p className="text-[11px] font-mono text-slate-500">
            job {job.id.slice(0, 18)}… · {job.coverage} · attempt {job.attempts} of {job.maxAttempts}
          </p>
        </div>

        <span
          className={`text-xs px-2.5 py-1 rounded-full border font-semibold flex items-center gap-1.5 ${
            wasCancelled || wasPaused
              ? 'bg-slate-800 border-slate-700 text-slate-300'
              : job.state === 'completed'
                ? 'bg-emerald-950/50 border-emerald-800 text-emerald-300'
                : job.state === 'failed'
                  ? 'bg-red-950/50 border-red-900 text-red-300'
                  : 'bg-slate-800 border-slate-700 text-slate-300'
          }`}
        >
          {wasPaused ? (
            <Pause className="w-3.5 h-3.5" />
          ) : wasCancelled ? (
            <Square className="w-3.5 h-3.5" />
          ) : job.state === 'completed' ? (
            <CheckCircle2 className="w-3.5 h-3.5" />
          ) : job.state === 'failed' ? (
            <XCircle className="w-3.5 h-3.5" />
          ) : (
            <Clock className="w-3.5 h-3.5" />
          )}
          {wasPaused ? 'paused' : wasCancelled ? 'cancelled' : job.state}
        </span>
      </div>

      {running && (
        <div className="space-y-3">
          <p className="text-xs text-slate-400 leading-relaxed">
            The job is queued on the server and runs whether or not this page stays open. Progress
            below is read from the job record, not estimated.
          </p>

          <div className="flex flex-wrap items-center gap-2">
            {onPause && (
              <button
                type="button"
                onClick={onPause}
                disabled={busy || job.pauseRequestedAt != null || job.cancelRequestedAt != null}
                className="inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs font-semibold text-slate-200 transition-colors hover:bg-slate-700 disabled:opacity-60"
              >
                <Pause className="w-3.5 h-3.5" />
                {job.pauseRequestedAt != null || busy ? 'Stopping…' : 'Pause run'}
              </button>
            )}

            {onCancel && (
              <button
                type="button"
                onClick={onCancel}
                disabled={busy || job.cancelRequestedAt != null}
                className="inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs font-semibold text-slate-200 transition-colors hover:bg-slate-700 disabled:opacity-60"
              >
                <Square className="w-3.5 h-3.5" />
                {job.cancelRequestedAt != null || busy ? 'Stopping…' : 'Cancel run'}
              </button>
            )}
          </div>

          {(job.pauseRequestedAt != null || job.cancelRequestedAt != null) && (
            <p className="text-[11px] text-amber-300/90">
              A stop has been requested. The run stops before its next provider call, so no further
              spending is started. Pausing keeps what the run had already done; cancelling discards
              the cards it had not yet stored.
            </p>
          )}

          {actionNotice && <p className="text-[11px] text-amber-300/90">{actionNotice}</p>}
        </div>
      )}

      {job.provider && (
        <p className="text-[11px] font-mono text-slate-500">
          {job.provider} · cards {job.model} · decisions {job.decisionModel}
          {job.pipelineVersion ? ` · pipeline ${job.pipelineVersion}` : ''}
        </p>
      )}

      {coverageSummary && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <Stat label="concepts found" value={coverageSummary.conceptsFound} />
          <Stat label="included" value={coverageSummary.conceptsIncluded} />
          <Stat label="cards stored" value={coverageSummary.cardsCreated} />
          <Stat label="cards withheld" value={coverageSummary.cardsWithheld} />
        </div>
      )}

      {coverageSummary && Object.keys(coverageSummary.withheldReasons).length > 0 && (
        <div className="space-y-1.5">
          <h3 className="text-xs font-semibold text-slate-300">Cards withheld, and why</h3>
          <ul className="space-y-1">
            {Object.entries(coverageSummary.withheldReasons).map(([code, count]) => (
              <li key={code} className="text-[11px] text-slate-400 flex items-start gap-2">
                <span className="font-mono text-slate-500">{count}×</span>
                <span>{describeWithheld(code)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {omissions.length > 0 && (
        <ul className="space-y-1">
          {omissions.slice(0, 5).map((line, index) => (
            <li key={index} className="text-[11px] text-amber-300/90">
              {line}
            </li>
          ))}
        </ul>
      )}

      {concepts.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-xs font-semibold text-slate-300 flex items-center gap-2">
            <ListTree className="w-3.5 h-3.5 text-cyan-400" />
            Concept inventory
          </h3>
          <p className="text-[11px] text-slate-500">
            {included.length} of {concepts.length} concepts became the basis for cards. Coverage
            changes which concepts are selected, not how many cards are promised.
          </p>

          <div className="rounded-xl border border-slate-800/80 divide-y divide-slate-800/60 overflow-hidden">
            {concepts.map(concept => {
              const isIncluded = concept.decision.startsWith('included');
              return (
                <div
                  key={concept.id}
                  className={`px-3 py-2.5 ${isIncluded ? 'bg-emerald-950/10' : 'bg-slate-950/30'}`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <span className="text-xs font-medium text-slate-200">{concept.label}</span>
                    <span className="text-[10px] font-mono text-slate-500 flex-shrink-0">
                      p.{concept.page_index} · {concept.kind} · centrality{' '}
                      {concept.centrality.toFixed(2)}
                    </span>
                  </div>
                  <div className="text-[11px] text-slate-500 mt-0.5">
                    {describeDecision(concept.decision)}
                    {concept.card_id ? ' · card stored' : ''}
                  </div>
                </div>
              );
            })}
          </div>

          {excluded.length > 0 && (
            <p className="text-[11px] text-slate-500">
              Concepts left out are listed above with the decision that left them out. None of them
              was silently dropped.
            </p>
          )}
        </div>
      )}
    </div>
  );
};
