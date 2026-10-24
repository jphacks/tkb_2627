import { randomUUID } from 'node:crypto';
import type { ErrorCode, GenerationInput, JobStage, JobState, JobStatus } from '@tkb/contracts';
import { parseBlueprint, type Runner } from '@tkb/ai';

interface SafeError {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  requestId: string;
}

/**
 * Minimal in-memory job handling for the K01/K02/K21 gate.
 * TODO(A03): durable job state machine, dedup window, restart recovery.
 * TODO(S04/A04): save candidates to the shared DB; until then no job may become `succeeded`.
 */
interface Job {
  jobId: string;
  ownerId: string;
  state: JobState;
  stage: JobStage;
  error: SafeError | null;
  updatedAt: string;
  input: GenerationInput;
  ctl: AbortController;
  cancelled: boolean;
  timedOut: boolean;
}

export interface JobManagerOptions {
  runner: Runner;
  queueLimit: number;
  timeoutMs: number;
  allowedPlaceIds?: readonly string[];
}

const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

export class JobManager {
  private readonly jobs = new Map<string, Job>();
  private readonly queue: Job[] = [];
  private running = false;
  /** ownerId + idempotency key -> jobId and request fingerprint */
  private readonly idem = new Map<string, { jobId: string; fingerprint: string }>();
  constructor(private readonly o: JobManagerOptions) {}

  submit(
    ownerId: string,
    key: string,
    fingerprint: string,
    input: GenerationInput,
  ): { kind: 'accepted'; jobId: string } | { kind: 'conflict' } | { kind: 'full' } {
    const k = `${ownerId}\n${key}`;
    const prev = this.idem.get(k);
    if (prev) return prev.fingerprint === fingerprint ? { kind: 'accepted', jobId: prev.jobId } : { kind: 'conflict' };
    if (this.queue.length >= this.o.queueLimit) return { kind: 'full' };
    const job: Job = {
      jobId: randomUUID(),
      ownerId,
      state: 'queued',
      stage: 'queued',
      error: null,
      updatedAt: nowIso(),
      input,
      ctl: new AbortController(),
      cancelled: false,
      timedOut: false,
    };
    this.jobs.set(job.jobId, job);
    this.idem.set(k, { jobId: job.jobId, fingerprint });
    this.queue.push(job);
    void this.pump();
    return { kind: 'accepted', jobId: job.jobId };
  }

  private set(job: Job, state: JobState, stage: JobStage, error: SafeError | null = null) {
    job.state = state;
    job.stage = stage;
    job.error = error;
    job.updatedAt = nowIso();
  }

  private err(code: ErrorCode, message: string, retryable: boolean) {
    return { code, message, retryable, requestId: randomUUID() };
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (let job = this.queue.shift(); job; job = this.queue.shift()) {
        if (job.state === 'queued') await this.execute(job);
      }
    } finally {
      this.running = false;
    }
  }

  private async execute(job: Job): Promise<void> {
    this.set(job, 'running', 'generating');
    const timer = setTimeout(() => {
      job.timedOut = true;
      job.ctl.abort();
    }, this.o.timeoutMs);
    try {
      const r = await this.o.runner.run(job.input, job.ctl.signal);
      if (job.cancelled) return;
      if (r.error || r.exitCode !== 0) {
        return this.set(job, 'failed', 'generating', r.error ?? this.err('CLI_EXIT', 'The generator exited with an error.', true));
      }
      this.set(job, 'running', 'validating');
      const p = parseBlueprint(r.envelope, this.o.allowedPlaceIds ?? job.input.allowedPlaceIds);
      if (!p.ok) return this.set(job, 'failed', 'validating', p.error);
      // Valid output, but candidates cannot be saved yet (needs S04): never report `succeeded` without batchId.
      this.set(job, 'failed', 'saving', this.err('UNAVAILABLE', 'Candidate saving is not yet available.', false));
    } catch (e) {
      if (job.cancelled) return;
      if (job.timedOut) return this.set(job, 'failed', 'generating', this.err('CLI_TIMEOUT', 'The generator timed out.', true));
      void e; // raw error text is never exposed
      this.set(job, 'failed', 'generating', this.err('CLI_EXIT', 'The generator failed.', true));
    } finally {
      clearTimeout(timer);
    }
  }

  /** Owner-scoped: other owners and unknown ids look identical (null). */
  status(ownerId: string, jobId: string): JobStatus | null {
    const j = this.jobs.get(jobId);
    if (!j || j.ownerId !== ownerId) return null;
    return {
      jobId: j.jobId,
      state: j.state,
      stage: j.stage,
      batchId: null,
      error: j.error && { ...j.error },
      updatedAt: j.updatedAt,
    };
  }

  cancel(ownerId: string, jobId: string): { jobId: string; state: JobState; batchId: null } | null {
    const j = this.jobs.get(jobId);
    if (!j || j.ownerId !== ownerId) return null;
    if (j.state === 'queued' || j.state === 'running') {
      j.cancelled = true;
      j.ctl.abort();
      this.set(j, 'cancelled', j.stage);
    }
    return { jobId: j.jobId, state: j.state, batchId: null };
  }
}
