import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Id, JobStatus, type ErrorCode, type JobStage, type JobState } from '@tkb/contracts';

/**
 * Durable job journal record. Metadata ONLY: never constraints, prompts, cookies, tokens or raw keys.
 */
export interface JobRecord {
  jobId: string;
  ownerId: string;
  /** HMAC of owner + Idempotency-Key (never the raw key). */
  idemHash: string;
  /** HMAC of the request fingerprint (never the body). */
  fingerprint: string;
  /** Deterministic per (owner, idempotency key); passed to the shared DB so saves dedupe. */
  operationKey: string;
  state: JobState;
  stage: JobStage;
  batchId: string | null;
  error: { code: ErrorCode; message: string; retryable: boolean; requestId: string } | null;
  updatedAt: string;
}

export interface JobStore {
  /** Per-install random secret for HMACing keys/fingerprints before they are journaled. */
  readonly secret: Buffer;
  loadAll(): JobRecord[];
  save(rec: JobRecord): void;
  remove(jobId: string): void;
}

const HEX64 = /^[0-9a-f]{64}$/;
const KEYS = ['batchId', 'error', 'fingerprint', 'idemHash', 'jobId', 'operationKey', 'ownerId', 'stage', 'state', 'updatedAt'];
/** Shape + refinements checked on load (reusing the contract's JobStatus rules); invalid records are quarantined. */
export function parseJobRecord(v: unknown): JobRecord | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  if (Object.keys(r).sort().join() !== KEYS.join()) return null;
  const st = JobStatus.safeParse({ jobId: r.jobId, state: r.state, stage: r.stage, batchId: r.batchId, error: r.error, updatedAt: r.updatedAt });
  if (!st.success) return null;
  if (!Id.safeParse(r.ownerId).success) return null;
  for (const k of ['idemHash', 'fingerprint', 'operationKey'] as const) if (typeof r[k] !== 'string' || !HEX64.test(r[k])) return null;
  if (st.data.state === 'succeeded' && st.data.stage !== 'done') return null;
  if (st.data.state === 'queued' && st.data.stage !== 'queued') return null;
  return { ...st.data, ownerId: r.ownerId as string, idemHash: r.idemHash as string, fingerprint: r.fingerprint as string, operationKey: r.operationKey as string };
}

export class MemoryJobStore implements JobStore {
  readonly secret = randomBytes(32);
  readonly records = new Map<string, JobRecord>();
  loadAll(): JobRecord[] {
    return [...this.records.values()].map(r => structuredClone(r));
  }
  save(rec: JobRecord): void {
    this.records.set(rec.jobId, structuredClone(rec));
  }
  remove(jobId: string): void {
    this.records.delete(jobId);
  }
}

const FILE = /^[A-Za-z0-9_-]{1,64}\.json$/;

/** One JSON file per job, written atomically (tmp + rename), owner-only permissions. */
export class FileJobStore implements JobStore {
  private readonly dir: string;
  readonly secret: Buffer;
  constructor(baseDir: string) {
    this.dir = join(baseDir, 'jobs');
    // Only our own subdirectory and secret file are chmod'ed; the user-provided base dir is left alone.
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    chmodSync(this.dir, 0o700);
    const sf = join(baseDir, 'secret');
    if (!existsSync(sf)) {
      // Write to a private tmp file, then link: the secret appears atomically and complete (EEXIST = lost the race).
      const tmp = `${sf}.${process.pid}.tmp`;
      writeFileSync(tmp, randomBytes(32).toString('hex'), { mode: 0o600 });
      try {
        linkSync(tmp, sf);
      } catch {
        /* created concurrently */
      } finally {
        rmSync(tmp, { force: true });
      }
    }
    chmodSync(sf, 0o600);
    this.secret = Buffer.from(readFileSync(sf, 'utf8').trim(), 'hex');
    if (this.secret.length < 32) throw new Error('invalid job journal secret');
  }
  private quarantine(f: string): void {
    try {
      renameSync(join(this.dir, f), join(this.dir, `${f}.corrupt`));
    } catch {
      /* ignore */
    }
  }
  loadAll(): JobRecord[] {
    const out: JobRecord[] = [];
    for (const f of readdirSync(this.dir)) {
      if (f.endsWith('.tmp')) {
        rmSync(join(this.dir, f), { force: true }); // stale partial write
        continue;
      }
      if (!FILE.test(f)) continue; // includes *.corrupt
      try {
        const r = parseJobRecord(JSON.parse(readFileSync(join(this.dir, f), 'utf8')));
        if (r && `${r.jobId}.json` === f) out.push(r);
        else this.quarantine(f);
      } catch {
        this.quarantine(f);
      }
    }
    return out;
  }
  save(rec: JobRecord): void {
    if (!FILE.test(`${rec.jobId}.json`)) throw new Error('invalid jobId');
    const final = join(this.dir, `${rec.jobId}.json`);
    const tmp = `${final}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(rec), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, final);
  }
  remove(jobId: string): void {
    if (!FILE.test(`${jobId}.json`)) return;
    rmSync(join(this.dir, `${jobId}.json`), { force: true });
  }
}
