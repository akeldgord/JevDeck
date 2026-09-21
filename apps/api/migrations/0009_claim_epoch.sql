-- 0009 — Claim ownership: a monotonic epoch for the lease (remediation v3, Step C).
--
-- The defect this closes: every write a run makes was keyed only by the job id. A worker that lost
-- its lease — because it paused longer than the lease, or its process was suspended — could have
-- the job reclaimed by another worker and still overwrite the new worker's progress, or finish it.
-- `worker_id` alone was not enough to prevent that, because a worker that lost and then reclaimed
-- its own job is the same `worker_id` with a different claim.
--
-- `claim_epoch` is incremented atomically every time a worker claims or reclaims a job. Together
-- with `worker_id` it is the *claim identity*: it is threaded through the pipeline, and every write
-- that carries job-progress authority — lease renewal, checkpoint writes, failure and stop
-- settlement, and the finalisation that publishes — is conditional on the row still carrying that
-- identity while `state = 'processing'` under a live lease. Zero affected rows means the claim is
-- gone, and the worker stops rather than writing over whoever holds the job now.
--
-- Billing is deliberately not part of this. A call that was already dispatched is settled under its
-- own immutable attempt and reservation ids, because losing job authority does not un-spend money.
-- The epoch guards who may mutate the *job*, not who may reconcile the *charge*.

ALTER TABLE generation_jobs ADD COLUMN claim_epoch INTEGER NOT NULL DEFAULT 0;
