import { createHash, createHmac, randomUUID } from 'node:crypto';
import { Id, type ErrorCode, type GenerationInput, type JobStage, type JobState, type JobStatus, type PlanBatchCreate, type PlanBlueprint, type TripConstraints } from '@tkb/contracts';
import { parseBlueprint, type Runner } from '@tkb/ai';
import { isSavingOrLater, isTerminalState, recoveryTransition, transition } from './state.ts';
import type { JobMetrics, StageInfo } from '../generation/metrics.ts';
import { MemoryJobStore, type JobRecord, type JobStore } from './store.ts';

export { transition } from './state.ts';
export { FileJobStore, MemoryJobStore, type JobRecord, type JobStore } from './store.ts';

interface SafeError {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  requestId: string;
}

/** What a job is asked to generate (A04). Held in memory only; never journaled. */
export interface JobRequest {
  constraints: TripConstraints;
  baseTripId: null;
  baseRevision: null;
}

export type StageFail = { ok: false; code: ErrorCode; retryable: boolean };

/**
 * The A04 stages around the runner. Each returns only a code and a retryable flag on failure; no text from
 * upstream or from the model is ever kept (FIXED_MESSAGES supplies the message).
 */
export interface GenerationPipeline {
  /** Stage collecting_context: K05 facts plus the model input. Must fail before any Claude run when the data is unusable. */
  collect(ownerId: string, req: JobRequest, signal: AbortSignal): Promise<{ ok: true; input: GenerationInput; ctx: unknown; info?: StageInfo } | StageFail>;
  /** Stage validating: deterministic assembly and checks of the parsed blueprint into a K07 body. */
  build(ownerId: string, blueprint: PlanBlueprint, ctx: unknown, operationKey: string, signal: AbortSignal): Promise<{ ok: true; batch: PlanBatchCreate; info?: StageInfo } | StageFail>;
  /** Stage saving: K07. Same semantics as the legacy `save` option (own timeout, unknown outcome consults findSavedBatch). */
  save(ownerId: string, batch: PlanBatchCreate, signal: AbortSignal): Promise<{ batchId: string }>;
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
  /** New attempt after a restart / unknown save outcome: consult findSavedBatch before generating. */
  recoverCheck: boolean;
  /** recoverCheck attempts: the pre-generate lookup has completed. Until then the outcome of earlier attempts is unknown. */
  lookupDone: boolean;
  /** Journal record deliberately left non-terminal (recovery lookup failed): never delete it on eviction. */
  keepJournal: boolean;
  state: JobState;
  stage: JobStage;
  error: SafeError | null;
  updatedAt: string;
  input: GenerationInput | null;
  /** Only for pipeline jobs. */
  request: JobRequest | null;
  ctx: unknown;
  /** Stage timings and info for onMetrics (memory only). */
  mx: { t0: number; marks: Record<string, number>; model: string | null; numTurns: number | null; info: StageInfo };
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
  /** A04 pipeline (K05 collect, assemble, K07 save). Without it jobs run the legacy path below. */
  pipeline?: GenerationPipeline;
  /** Legacy (pre-pipeline) allowed place IDs; used only when no pipeline is set. Default is none. */
  allowedPlaceIds?: readonly string[];
  /** Terminal jobs (and their idempotency entries) kept before the oldest are evicted. */
  maxFinished?: number;
  /** Evicted terminal jobs kept as compact journal records so a same-key resubmit returns the old result (default 5000, oldest pruned). */
  tombstoneLimit?: number;
  /** Durable journal. Default: in-memory (lost on restart). */
  store?: JobStore;
  /**
   * Restart recovery: ask the shared DB whether a batch was already saved for this operation.
   * Real lookup arrives with S04/A04; default finds nothing.
   */
  findSavedBatch?: (ownerId: string, operationKey: string) => Promise<string | null>;
  /**
   * Legacy saver (no pipeline). Must pass `operationKey` so the server can dedupe. Absent: valid output fails with UNAVAILABLE.
   */
  save?: (ctx: SaveContext) => Promise<{ batchId: string }>;
  /** Upper bound for one save call (default 60s). On expiry findSavedBatch is consulted before failing. */
  saveTimeoutMs?: number;
  /** Content-free metrics when a pipeline job ends (A04). */
  onMetrics?: (m: JobMetrics) => void;
  /** Upper bound for one findSavedBatch call (default 10s); expiry counts as a failed lookup. */
  lookupTimeoutMs?: number;
}

export interface SaveContext {
  jobId: string;
  ownerId: string;
  operationKey: string;
  signal: AbortSignal;
  envelope: unknown;
}

export type SubmitResult = { kind: 'accepted'; jobId: string } | { kind: 'conflict' } | { kind: 'full' };

const newMx = (): Job['mx'] => ({ t0: Date.now(), marks: {}, model: null, numTurns: null, info: {} });
const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
const isActive = (j: Job) => !isTerminalState(j.state);
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
/** Deterministic per (owner, idempotency key); the shared DB uses it to dedupe saves. */
export const operationKeyOf = (ownerId: string, key: string): string => sha(`${ownerId}:${key}`);

const FIXED_MESSAGES: Partial<Record<ErrorCode, string>> = {
  CLI_EXIT: 'The generator exited with an error.',
  CLI_TIMEOUT: 'The generator timed out.',
  CLI_LIMIT: 'Usage limit reached.',
  INVALID_OUTPUT: 'The generator returned an invalid result.',
  UNAVAILABLE: 'The service is unavailable.',
  UNAUTHENTICATED: 'Login required; please sign in again.',
  VALIDATION_FAILED: 'The request could not be used.',
  RATE_LIMITED: 'Too many requests; please retry later.',
  PROVIDER_UNAVAILABLE: 'The travel data source is unavailable.',
  PROVIDER_RATE_LIMIT: 'The travel data limit was reached.',
  PROVIDER_UNSUPPORTED_REGION: 'This region is not supported yet.',
  CONSTRAINT_UNSATISFIED: 'No usable plan could be built from the available data.',
  RESTRICTED_ASSET: 'Some data may not be stored.',
  CANCELLED: 'The request was cancelled.',
};

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
  /** Evicted terminal jobs (compact journal records), oldest first. */
  private readonly tomb = new Map<string, JobRecord>();
  private running = false;
  /** idemHash -> jobId and request fingerprint */
  private readonly idem = new Map<string, { jobId: string; fingerprint: string }>();
  private readonly store: JobStore;
  private readonly mac: (s: string) => string;
  /** Resolves when restart recovery is done. Await before serving requests. */
  readonly ready: Promise<void>;
  constructor(private readonly o: JobManagerOptions) {
    this.store = o.store ?? new MemoryJobStore();
    this.mac = s => createHmac('sha256', this.store.secret).update(s).digest('hex');
    this.ready = this.recover();
    this.ready.catch(() => {}); // surfaced where it is awaited (app onReady); never an unhandled rejection
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

  /**
   * Loads the journal. EVERY non-terminal job asks findSavedBatch first (a save may have committed
   * before the crash): found -> succeeded; none -> failed WORKER_RESTARTED (persisted); lookup error ->
   * failed in memory only, the journal record stays non-terminal so the next start re-checks.
   */
  private async recover(): Promise<void> {
    const recs = this.store.loadAll().sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
    for (const r of recs) {
      const job: Job = {
        ...r,
        requestId: r.error?.requestId ?? 'recovery',
        idemKey: r.idemHash,
        recoverCheck: false,
        lookupDone: true,
        keepJournal: false,
        input: null,
        request: null,
        ctx: null,
        mx: newMx(),
        ctl: new AbortController(),
        timer: null,
        cancelled: false,
        timedOut: false,
      };
      this.jobs.set(job.jobId, job);
      this.idem.set(job.idemHash, { jobId: job.jobId, fingerprint: job.fingerprint });
      if (!isActive(job)) {
        this.finish(job);
        continue;
      }
      job.requestId = 'recovery';
      const { batch, lookupFailed } = await this.lookup(job);
      if (batch) {
        job.batchId = batch;
        this.set(job, 'succeeded', 'done', null, { recovery: true });
      } else {
        job.keepJournal = lookupFailed;
        this.set(job, 'failed', job.stage, this.err(job, 'WORKER_RESTARTED', 'The worker restarted; please retry.', true), { recovery: true, noPersist: lookupFailed });
      }
    }
  }

  private async lookup(job: Job): Promise<{ batch: string | null; lookupFailed: boolean }> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const call = Promise.resolve(this.o.findSavedBatch?.(job.ownerId, job.operationKey) ?? null);
      call.catch(() => {});
      const timeout = new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(new Error('lookup timeout')), this.o.lookupTimeoutMs ?? 10_000);
        timer.unref();
      });
      const b = await Promise.race([call, timeout]);
      if (b === null) return { batch: null, lookupFailed: false };
      return Id.safeParse(b).success ? { batch: b, lookupFailed: false } : { batch: null, lookupFailed: true };
    } catch {
      return { batch: null, lookupFailed: true };
    } finally {
      clearTimeout(timer);
    }
  }

  /** A failed job whose save may have committed (restart, or save at/after stage saving): resubmit starts a new attempt. */
  private isRetryableAttempt(j: Job): boolean {
    if (j.state === 'cancelled') return j.recoverCheck || j.stage === 'collecting_context';
    if (j.state !== 'failed') return false;
    // collecting_context is only ever the stage of an attempt that died during the pre-generate lookup.
    return j.error?.code === 'WORKER_RESTARTED' || isSavingOrLater(j.stage) || j.stage === 'collecting_context' || (j.recoverCheck && !j.lookupDone);
  }

  /** Live job, or an evicted one rehydrated from its compact record. */
  private getJob(jobId: string): Job | undefined {
    const live = this.jobs.get(jobId);
    if (live) return live;
    const r = this.tomb.get(jobId);
    if (!r) return undefined;
    this.tomb.delete(jobId);
    const job: Job = {
      ...r,
      requestId: r.error?.requestId ?? 'recovery',
      idemKey: r.idemHash,
      recoverCheck: false,
      lookupDone: true,
      keepJournal: false,
      input: null,
      request: null,
      ctx: null,
      mx: newMx(),
      ctl: new AbortController(),
      timer: null,
      cancelled: false,
      timedOut: false,
    };
    this.jobs.set(job.jobId, job);
    this.finish(job);
    return job;
  }

  /** `work` is a JobRequest (pipeline) or, for the legacy path, a ready GenerationInput. */
  submit(ownerId: string, key: string, fingerprint: string, work: JobRequest | GenerationInput, requestId: string = randomUUID()): SubmitResult {
    const legacy = 'allowedPlaceIds' in work;
    const k = this.mac(`idem\n${ownerId}\n${key}`);
    const fp = this.mac(fingerprint);
    const prev = this.idem.get(k);
    let recoverCheck = false;
    if (prev) {
      if (prev.fingerprint !== fp) return { kind: 'conflict' };
      const pj = this.getJob(prev.jobId);
      if (!pj || !this.isRetryableAttempt(pj)) return { kind: 'accepted', jobId: prev.jobId };
      recoverCheck = true; // new attempt, same operationKey so the shared server can dedupe
    }
    if (this.queue.length >= this.o.queueLimit) return { kind: 'full' };
    const job: Job = {
      jobId: randomUUID(),
      ownerId,
      requestId,
      idemKey: k,
      idemHash: k,
      fingerprint: fp,
      operationKey: operationKeyOf(ownerId, key),
      batchId: null,
      recoverCheck,
      lookupDone: !recoverCheck,
      keepJournal: false,
      state: 'queued',
      stage: 'queued',
      error: null,
      updatedAt: nowIso(),
      input: legacy ? work : null,
      request: legacy ? null : work,
      ctx: null,
      mx: newMx(),
      ctl: new AbortController(),
      timer: null,
      cancelled: false,
      timedOut: false,
    };
    this.persist(job); // before registering: a failed write rejects the submit
    this.jobs.set(job.jobId, job);
    this.idem.set(k, { jobId: job.jobId, fingerprint: fp });
    this.queue.push(job);
    job.timer = setTimeout(() => this.onDeadline(job), this.o.timeoutMs);
    job.timer.unref();
    void this.pump();
    return { kind: 'accepted', jobId: job.jobId };
  }

  private onDeadline(job: Job): void {
    if (!isActive(job)) return;
    // From stage saving on, the save may commit: never abort it by deadline (the save has its own timeout).
    if (job.state === 'running' && isSavingOrLater(job.stage)) return;
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

  private set(
    job: Job,
    state: JobState,
    stage: JobStage,
    error: SafeError | null = null,
    opts: { recovery?: boolean; noPersist?: boolean; strict?: boolean } = {},
  ) {
    const from = { state: job.state, stage: job.stage };
    const next = (opts.recovery ? recoveryTransition : transition)(from, { state, stage });
    const prev = { error: job.error, updatedAt: job.updatedAt };
    job.state = next.state;
    job.stage = next.stage;
    job.error = error;
    job.updatedAt = nowIso();
    if (!opts.noPersist) {
      try {
        this.persist(job);
      } catch (e) {
        if (opts.strict) {
          // Mandatory write failed: roll back so memory and journal agree.
          job.state = from.state;
          job.stage = from.stage;
          job.error = prev.error;
          job.updatedAt = prev.updatedAt;
          throw e;
        }
        /* otherwise the in-memory state stays authoritative; a lost write only weakens restart recovery */
      }
    }
    if (!isActive(job)) {
      if (!opts.recovery) this.emitMetrics(job);
      job.input = null; // not needed once terminal
      job.request = null;
      job.ctx = null;
    }
    if (!isActive(job)) this.finish(job);
  }

  private emitMetrics(job: Job): void {
    if (!this.o.onMetrics || !this.o.pipeline) return;
    const m = job.mx.marks;
    try {
      this.o.onMetrics({
        state: job.state,
        errorCode: job.error?.code ?? null,
        collectMs: m.collectMs ?? null,
        generateMs: m.generateMs ?? null,
        buildMs: m.buildMs ?? null,
        saveMs: m.saveMs ?? null,
        totalMs: Date.now() - job.mx.t0,
        model: job.mx.model,
        numTurns: job.mx.numTurns,
        info: job.mx.info,
      });
    } catch {
      /* metrics must never affect a job */
    }
  }

  private finish(job: Job): void {
    if (job.timer) clearTimeout(job.timer);
    job.timer = null;
    if (this.finished.includes(job)) return;
    this.finished.push(job);
    const max = this.o.maxFinished ?? 500;
    while (this.finished.length > max) {
      const old = this.finished.shift()!;
      this.jobs.delete(old.jobId);
      if (old.keepJournal) {
        if (this.idem.get(old.idemKey)?.jobId === old.jobId) this.idem.delete(old.idemKey);
        continue;
      }
      // Keep the (metadata-only) journal record so a same-key resubmit returns the old result.
      this.tomb.set(old.jobId, this.toRecord(old));
    }
    const lim = this.o.tombstoneLimit ?? 5000;
    while (this.tomb.size > lim) {
      const [id, rec] = this.tomb.entries().next().value!;
      this.tomb.delete(id);
      if (this.idem.get(rec.idemHash)?.jobId === id) this.idem.delete(rec.idemHash);
      try {
        this.store.remove(id);
      } catch {
        /* ignore */
      }
    }
  }

  /** Runner/parser text is never stored or returned: only the code and retryable flag are kept, with a fixed message. */
  private safeErr(job: Job, e: { code: ErrorCode; retryable: boolean }): SafeError {
    return this.err(job, e.code, FIXED_MESSAGES[e.code] ?? 'The generator failed.', e.retryable);
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
    if (job.recoverCheck) {
      // A previous attempt with this operationKey may have committed: never generate/save twice.
      const { batch } = await this.lookup(job);
      job.lookupDone = true;
      if (!isActive(job)) return;
      if (batch) {
        job.batchId = batch;
        return this.set(job, 'succeeded', 'done');
      }
      if (job.ctl.signal.aborted) return this.set(job, 'failed', job.stage, this.err(job, 'CLI_TIMEOUT', 'The generator timed out.', true));
    }
    // Race against abort so a stage that ignores the signal cannot block the queue (deadline covers collect, runner and build).
    const aborted = new Promise<never>((_, reject) => {
      if (job.ctl.signal.aborted) return reject(new DOMException('aborted', 'AbortError'));
      job.ctl.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    });
    aborted.catch(() => {});
    const guarded = <T>(p: Promise<T>): Promise<T> => {
      p.catch(() => {});
      return Promise.race([p, aborted]);
    };
    const pipe = this.o.pipeline;
    try {
      if (pipe) {
        if (!job.request) return this.set(job, 'failed', job.stage, this.err(job, 'UNAVAILABLE', 'The service is unavailable.', false));
        const t = Date.now();
        const c = await guarded(pipe.collect(job.ownerId, job.request, job.ctl.signal));
        job.mx.marks.collectMs = Date.now() - t;
        if (!isActive(job)) return;
        if (!c.ok) return this.set(job, 'failed', job.stage, this.safeErr(job, c));
        job.input = c.input;
        job.ctx = c.ctx;
        Object.assign(job.mx.info, c.info);
      } else if (!job.input) {
        return this.set(job, 'failed', job.stage, this.err(job, 'UNAVAILABLE', 'The service is unavailable.', false));
      }
      this.set(job, 'running', 'generating');
      const tg = Date.now();
      const r = await guarded(this.o.runner.run(job.input!, job.ctl.signal));
      job.mx.marks.generateMs = Date.now() - tg;
      job.mx.model = r.meta?.model ?? null;
      job.mx.numTurns = r.meta?.numTurns ?? null;
      if (!isActive(job)) return;
      if (r.error || r.exitCode !== 0) {
        const e = r.error ?? this.err(job, 'CLI_EXIT', '', true);
        return this.set(job, 'failed', job.stage, this.safeErr(job, e));
      }
      this.set(job, 'running', 'validating');
      const p = parseBlueprint(r.envelope, pipe ? job.input!.allowedPlaceIds : (this.o.allowedPlaceIds ?? []));
      if (!p.ok) return this.set(job, 'failed', job.stage, this.safeErr(job, p.error));
      if (pipe) {
        const tb = Date.now();
        const built = await guarded(pipe.build(job.ownerId, p.blueprint, job.ctx, job.operationKey, job.ctl.signal));
        job.mx.marks.buildMs = Date.now() - tb;
        if (!isActive(job)) return;
        if (!built.ok) return this.set(job, 'failed', job.stage, this.safeErr(job, built));
        Object.assign(job.mx.info, built.info);
        if (!this.beforeSave(job)) return;
        return await this.doSave(job, s => pipe.save(job.ownerId, built.batch, s));
      }
      if (!this.o.save) {
        // Valid output, but candidates cannot be saved yet: never report `succeeded` without batchId.
        return this.set(job, 'failed', 'validating', this.err(job, 'UNAVAILABLE', 'Candidate saving is not yet available.', false));
      }
      if (!this.beforeSave(job)) return;
      const envelope = r.envelope;
      const legacySave = this.o.save;
      return await this.doSave(job, s => legacySave({ jobId: job.jobId, ownerId: job.ownerId, operationKey: job.operationKey, signal: s, envelope }));
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
    try {
      // Mandatory durable write: if `saving` is not journaled we must not save (a crash would lose track of it).
      this.set(job, 'running', 'saving', null, { strict: true });
    } catch {
      this.set(job, 'failed', job.stage, this.err(job, 'UNAVAILABLE', 'Could not record the save; please retry.', true));
      return false;
    }
    return true;
  }

  /** Runs the saver with its own timeout (deadline/cancel no longer apply). Unknown outcomes consult findSavedBatch. */
  private async doSave(job: Job, save: (signal: AbortSignal) => Promise<{ batchId: string }>): Promise<void> {
    const saveCtl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>(res => {
      timer = setTimeout(() => res('timeout'), this.o.saveTimeoutMs ?? 60_000);
      timer.unref();
    });
    try {
      const ts = Date.now();
      const p = save(saveCtl.signal);
      p.finally(() => (job.mx.marks.saveMs = Date.now() - ts)).catch(() => {});
      p.catch(() => {});
      const out = await Promise.race([p, timeout]);
      if (out === 'timeout') {
        saveCtl.abort();
        return await this.settleUnknownSave(job);
      }
      const id = Id.safeParse(out?.batchId);
      if (!id.success) return await this.settleUnknownSave(job);
      job.batchId = id.data;
      this.set(job, 'running', 'saved');
      this.set(job, 'succeeded', 'done');
    } catch {
      await this.settleUnknownSave(job);
    } finally {
      clearTimeout(timer);
    }
  }

  private async settleUnknownSave(job: Job): Promise<void> {
    const { batch } = await this.lookup(job);
    if (!isActive(job)) return;
    if (batch) {
      job.batchId = batch;
      this.set(job, 'running', 'saved');
      return this.set(job, 'succeeded', 'done');
    }
    this.set(job, 'failed', job.stage, this.err(job, 'UNAVAILABLE', 'Saving the candidates failed; please retry.', true));
  }

  /** Owner-scoped: other owners and unknown ids look identical (null). */
  status(ownerId: string, jobId: string): JobStatus | null {
    const j = this.getJob(jobId);
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
    const j = this.getJob(jobId);
    if (!j || j.ownerId !== ownerId) return null;
    const wasActive = isActive(j);
    // Saving or later, or a resubmitted attempt whose lookup of earlier attempts is still pending: the outcome is unknown, so never claim cancelled.
    if (wasActive && (isSavingOrLater(j.stage) || (j.recoverCheck && !j.lookupDone))) {
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
