import { createHash, randomUUID } from 'node:crypto';
import type { ErrorCode, GenerationInput, JobStage, JobState, JobStatus } from '@tkb/contracts';
import { parseBlueprint, type Runner } from '@tkb/ai';
import { isSavingOrLater, isTerminalState, transition } from './state.ts';
import { MemoryJobStore, type JobRecord, type JobStore } from './store.ts';

export { transition } from './state.ts';
export { FileJobStore, MemoryJobStore, type JobRecord, type JobStore } from './store.ts';

interface SafeError {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  requestId: string;
}

/**
 * Minimal in-memory job handling for the K01/K02/K21 gate.
 * State machine in ./state.ts, durable metadata-only journal in ./store.ts.
 * TODO(S04/A04): wire `save` to the shared client; until then no job may become `succeeded`.
 * TODO(A04): pass baseTripId/expectedRevision through (the HTTP gate rejects them with 422 until then).
 */
interface Job {
  jobId: string;
  ownerId: string;
  /** HTTP request id of the submitting request; used as SafeError.requestId. */
  requestId: string;
  idemKey: string;
  idemHash: string;
  fingerprint: string;
  operationKey: string;
  batchId: string | null;
  state: JobState;
  stage: JobStage;
  error: SafeError | null;
  updatedAt: string;
  input: GenerationInput | null;
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
  /** Durable journal. Default: in-memory (lost on restart). */
  store?: JobStore;
  /**
   * Restart recovery: ask the shared DB whether a batch was already saved for this operation.
   * Real lookup arrives with S04/A04; default finds nothing.
   */
  findSavedBatch?: (ownerId: string, operationKey: string) => Promise<string | null>;
  /**
   * Saves a validated blueprint to the shared DB (S04/A04). Must pass `operationKey` so the
   * server can dedupe. Absent: valid output fails with UNAVAILABLE.
   */
  save?: (ctx: SaveContext) => Promise<{ batchId: string }>;
}

export interface SaveContext {
  jobId: string;
  ownerId: string;
  operationKey: string;
  signal: AbortSignal;
  envelope: unknown;
}

export type SubmitResult = { kind: 'accepted'; jobId: string } | { kind: 'conflict' } | { kind: 'full' };

const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
const isActive = (j: Job) => !isTerminalState(j.state);
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
/** Deterministic per (owner, idempotency key); the shared DB uses it to dedupe saves. */
export const operationKeyOf = (ownerId: string, key: string): string => sha(`${ownerId}:${key}`);
const idemHashOf = (ownerId: string, key: string): string => sha(`idem\n${ownerId}\n${key}`);

export interface CancelOutcome {
  jobId: string;
  state: JobState;
  batchId: string | null;
  wasActive: boolean;
  /** Stage is saving or later: the save may be committed, so cancel was NOT applied (HTTP 409 ALREADY_COMMITTED). */
  committed: boolean;
}

export class JobManager {
  private readonly jobs = new Map<string, Job>();
  private readonly queue: Job[] = [];
  private readonly finished: Job[] = [];
  private running = false;
  /** idemHash -> jobId and request fingerprint */
  private readonly idem = new Map<string, { jobId: string; fingerprint: string }>();
  private readonly store: JobStore;
  /** Resolves when restart recovery is done. Await before serving requests. */
  readonly ready: Promise<void>;
  constructor(private readonly o: JobManagerOptions) {
    this.store = o.store ?? new MemoryJobStore();
    this.ready = this.recover();
  }

  private toRecord(j: Job): JobRecord {
    return {
      jobId: j.jobId,
      ownerId: j.ownerId,
      idemHash: j.idemHash,
      fingerprint: j.fingerprint,
      operationKey: j.operationKey,
      state: j.state,
      stage: j.stage,
      batchId: j.batchId,
      error: j.error && { ...j.error },
      updatedAt: j.updatedAt,
    };
  }

  private persist(j: Job): void {
    this.store.save(this.toRecord(j));
  }

  /** Loads the journal; every non-terminal job from a previous process becomes failed/WORKER_RESTARTED (or succeeded if its batch exists). */
  private async recover(): Promise<void> {
    const recs = this.store.loadAll().sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
    for (const r of recs) {
      const job: Job = {
        ...r,
        requestId: r.error?.requestId ?? 'recovery',
        idemKey: r.idemHash,
        input: null,
        ctl: new AbortController(),
        timer: null,
        cancelled: false,
        timedOut: false,
      };
      this.jobs.set(job.jobId, job);
      this.idem.set(job.idemHash, { jobId: job.jobId, fingerprint: job.fingerprint });
      if (isActive(job)) {
        let batch: string | null = null;
        if (job.state === 'running') {
          try {
            batch = (await this.o.findSavedBatch?.(job.ownerId, job.operationKey)) ?? null;
          } catch {
            batch = null;
          }
        }
        if (batch) {
          job.batchId = batch;
          this.set(job, 'succeeded', 'done');
        } else {
          job.requestId = 'recovery';
          this.set(job, 'failed', job.stage, this.err(job, 'WORKER_RESTARTED', 'The worker restarted; please retry.', true));
        }
      } else {
        this.finish(job);
      }
    }
  }

  submit(ownerId: string, key: string, fingerprint: string, input: GenerationInput, requestId: string = randomUUID()): SubmitResult {
    const k = idemHashOf(ownerId, key);
    const prev = this.idem.get(k);
    if (prev) return prev.fingerprint === fingerprint ? { kind: 'accepted', jobId: prev.jobId } : { kind: 'conflict' };
    if (this.queue.length >= this.o.queueLimit) return { kind: 'full' };
    const job: Job = {
      jobId: randomUUID(),
      ownerId,
      requestId,
      idemKey: k,
      idemHash: k,
      fingerprint,
      operationKey: operationKeyOf(ownerId, key),
      batchId: null,
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
    this.persist(job); // before registering: a failed write rejects the submit
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
    const next = transition({ state: job.state, stage: job.stage }, { state, stage });
    job.state = next.state;
    job.stage = next.stage;
    job.error = error;
    job.updatedAt = nowIso();
    if (!isActive(job)) job.input = null; // not needed once terminal
    try {
      this.persist(job);
    } catch {
      /* the in-memory state stays authoritative; a lost journal write only weakens restart recovery */
    }
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
      try {
        this.store.remove(old.jobId);
      } catch {
        /* ignore */
      }
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
    this.set(job, 'running', 'collecting_context');
    this.set(job, 'running', 'generating');
    // Race against abort so a runner that ignores the signal cannot block the queue.
    const aborted = new Promise<never>((_, reject) => {
      job.ctl.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    });
    aborted.catch(() => {});
    try {
      const run = this.o.runner.run(job.input!, job.ctl.signal);
      run.catch(() => {});
      const r = await Promise.race([run, aborted]);
      if (!isActive(job)) return;
      if (r.error || r.exitCode !== 0) {
        const e = r.error ?? this.err(job, 'CLI_EXIT', 'The generator exited with an error.', true);
        return this.set(job, 'failed', job.stage, { ...e, requestId: job.requestId });
      }
      this.set(job, 'running', 'validating');
      const p = parseBlueprint(r.envelope, this.o.allowedPlaceIds ?? []);
      if (!p.ok) return this.set(job, 'failed', job.stage, { ...p.error, requestId: job.requestId });
      if (!this.o.save) {
        // Valid output, but candidates cannot be saved yet (needs S04): never report `succeeded` without batchId.
        return this.set(job, 'failed', 'validating', this.err(job, 'UNAVAILABLE', 'Candidate saving is not yet available.', false));
      }
      if (!this.beforeSave(job)) return;
      const saved = await this.o.save({ jobId: job.jobId, ownerId: job.ownerId, operationKey: job.operationKey, signal: job.ctl.signal, envelope: r.envelope });
      job.batchId = saved.batchId;
      this.set(job, 'running', 'saved');
      this.set(job, 'succeeded', 'done');
    } catch {
      // Raw error text is never exposed.
      if (!isActive(job)) return;
      if (job.timedOut) return this.set(job, 'failed', job.stage, this.err(job, 'CLI_TIMEOUT', 'The generator timed out.', true));
      this.set(job, 'failed', job.stage, this.err(job, 'CLI_EXIT', 'The generator failed.', true));
    }
  }

  /**
   * Pre-save cancel check for the saver. Returns false (and the job is already cancelled/failed)
   * if the job was cancelled or timed out; otherwise enters stage `saving`, after which cancel
   * is refused as committed. Called synchronously right before the shared-DB save.
   */
  private beforeSave(job: Job): boolean {
    if (!isActive(job) || job.ctl.signal.aborted) return false;
    this.set(job, 'running', 'saving');
    return true;
  }

  /** Owner-scoped: other owners and unknown ids look identical (null). */
  status(ownerId: string, jobId: string): JobStatus | null {
    const j = this.jobs.get(jobId);
    if (!j || j.ownerId !== ownerId) return null;
    return {
      jobId: j.jobId,
      state: j.state,
      stage: j.stage,
      batchId: j.batchId,
      error: j.error && { ...j.error },
      updatedAt: j.updatedAt,
    };
  }

  /**
   * K21. queued/running -> cancelled (wasActive). Terminal -> unchanged. Stage saving or later:
   * not cancelled, `committed` is true and the batchId (if known) is reported.
   */
  cancel(ownerId: string, jobId: string): CancelOutcome | null {
    const j = this.jobs.get(jobId);
    if (!j || j.ownerId !== ownerId) return null;
    const wasActive = isActive(j);
    if (wasActive && isSavingOrLater(j.stage)) {
      return { jobId: j.jobId, state: j.state, batchId: j.batchId, wasActive: false, committed: true };
    }
    if (wasActive) {
      j.cancelled = true;
      this.dequeue(j); // frees queue capacity immediately
      j.ctl.abort();
      this.set(j, 'cancelled', j.stage);
    }
    return { jobId: j.jobId, state: j.state, batchId: j.batchId, wasActive, committed: false };
  }
}
