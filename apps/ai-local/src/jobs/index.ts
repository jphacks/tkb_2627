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
  /** HTTP request id of the submitting request; used as SafeError.requestId. */
  requestId: string;
  idemKey: string;
  state: JobState;
  stage: JobStage;
  error: SafeError | null;
  updatedAt: string;
  input: GenerationInput;
  ctl: AbortController;
  timer: ReturnType<typeof setTimeout> | null;
  cancelled: boolean;
  timedOut: boolean;
}

export interface JobManagerOptions {
  runner: Runner;
  queueLimit: number;
  /**
   * Overall deadline per job, counted from submit (queue wait included).
   * Expiry while queued fails the job with CLI_TIMEOUT; while running it aborts the runner.
   */
  timeoutMs: number;
  /** Real allowed place IDs come from the shared server in A04; default is none. */
  allowedPlaceIds?: readonly string[];
  /** Terminal jobs (and their idempotency entries) kept before the oldest are evicted. */
  maxFinished?: number;
}

export type SubmitResult = { kind: 'accepted'; jobId: string } | { kind: 'conflict' } | { kind: 'full' };

const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
const isActive = (j: Job) => j.state === 'queued' || j.state === 'running';

export class JobManager {
  private readonly jobs = new Map<string, Job>();
  private readonly queue: Job[] = [];
  private readonly finished: Job[] = [];
  private running = false;
  /** ownerId + idempotency key -> jobId and request fingerprint */
  private readonly idem = new Map<string, { jobId: string; fingerprint: string }>();
  constructor(private readonly o: JobManagerOptions) {}

  submit(ownerId: string, key: string, fingerprint: string, input: GenerationInput, requestId: string = randomUUID()): SubmitResult {
    const k = `${ownerId}\n${key}`;
    const prev = this.idem.get(k);
    if (prev) return prev.fingerprint === fingerprint ? { kind: 'accepted', jobId: prev.jobId } : { kind: 'conflict' };
    if (this.queue.length >= this.o.queueLimit) return { kind: 'full' };
    const job: Job = {
      jobId: randomUUID(),
      ownerId,
      requestId,
      idemKey: k,
      state: 'queued',
      stage: 'queued',
      error: null,
      updatedAt: nowIso(),
      input,
      ctl: new AbortController(),
      timer: null,
      cancelled: false,
      timedOut: false,
    };
    this.jobs.set(job.jobId, job);
    this.idem.set(k, { jobId: job.jobId, fingerprint });
    this.queue.push(job);
    job.timer = setTimeout(() => this.onDeadline(job), this.o.timeoutMs);
    job.timer.unref();
    void this.pump();
    return { kind: 'accepted', jobId: job.jobId };
  }

  private onDeadline(job: Job): void {
    if (!isActive(job)) return;
    job.timedOut = true;
    if (job.state === 'queued') {
      this.dequeue(job);
      this.set(job, 'failed', 'queued', this.err(job, 'CLI_TIMEOUT', 'The generator timed out.', true));
    } else {
      job.ctl.abort();
    }
  }

  private dequeue(job: Job): void {
    const i = this.queue.indexOf(job);
    if (i >= 0) this.queue.splice(i, 1);
  }

  private set(job: Job, state: JobState, stage: JobStage, error: SafeError | null = null) {
    job.state = state;
    job.stage = stage;
    job.error = error;
    job.updatedAt = nowIso();
    if (!isActive(job)) this.finish(job);
  }

  private finish(job: Job): void {
    if (job.timer) clearTimeout(job.timer);
    job.timer = null;
    if (this.finished.includes(job)) return;
    this.finished.push(job);
    const max = this.o.maxFinished ?? 100;
    while (this.finished.length > max) {
      const old = this.finished.shift()!;
      this.jobs.delete(old.jobId);
      this.idem.delete(old.idemKey);
    }
  }

  private err(job: Job, code: ErrorCode, message: string, retryable: boolean): SafeError {
    return { code, message, retryable, requestId: job.requestId };
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
    // Race against abort so a runner that ignores the signal cannot block the queue.
    const aborted = new Promise<never>((_, reject) => {
      job.ctl.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    });
    aborted.catch(() => {});
    try {
      const run = this.o.runner.run(job.input, job.ctl.signal);
      run.catch(() => {});
      const r = await Promise.race([run, aborted]);
      if (!isActive(job)) return;
      if (r.error || r.exitCode !== 0) {
        const e = r.error ?? this.err(job, 'CLI_EXIT', 'The generator exited with an error.', true);
        return this.set(job, 'failed', 'generating', { ...e, requestId: job.requestId });
      }
      this.set(job, 'running', 'validating');
      const p = parseBlueprint(r.envelope, this.o.allowedPlaceIds ?? []);
      if (!p.ok) return this.set(job, 'failed', 'validating', { ...p.error, requestId: job.requestId });
      // Valid output, but candidates cannot be saved yet (needs S04): never report `succeeded` without batchId.
      this.set(job, 'failed', 'saving', this.err(job, 'UNAVAILABLE', 'Candidate saving is not yet available.', false));
    } catch {
      // Raw error text is never exposed.
      if (!isActive(job)) return;
      if (job.timedOut) return this.set(job, 'failed', 'generating', this.err(job, 'CLI_TIMEOUT', 'The generator timed out.', true));
      this.set(job, 'failed', 'generating', this.err(job, 'CLI_EXIT', 'The generator failed.', true));
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

  /** wasActive: the job was still queued/running (cancel accepted); false if already terminal. */
  cancel(ownerId: string, jobId: string): { jobId: string; state: JobState; batchId: null; wasActive: boolean } | null {
    const j = this.jobs.get(jobId);
    if (!j || j.ownerId !== ownerId) return null;
    const wasActive = isActive(j);
    if (wasActive) {
      j.cancelled = true;
      this.dequeue(j); // frees queue capacity immediately
      j.ctl.abort();
      this.set(j, 'cancelled', j.stage);
    }
    return { jobId: j.jobId, state: j.state, batchId: null, wasActive };
  }
}
