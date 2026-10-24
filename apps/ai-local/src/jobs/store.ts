import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ErrorCode, JobStage, JobState } from '@tkb/contracts';

/**
 * Durable job journal record. Metadata ONLY: never constraints, prompts, cookies, tokens or raw keys.
 */
export interface JobRecord {
  jobId: string;
  ownerId: string;
  /** sha256 of owner + Idempotency-Key (never the raw key). */
  idemHash: string;
  /** sha256 of the request body, computed by the caller. */
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
  loadAll(): JobRecord[];
  save(rec: JobRecord): void;
  remove(jobId: string): void;
}

export class MemoryJobStore implements JobStore {
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

const FILE = /^[A-Za-z0-9-]{1,64}\.json$/;

/** One JSON file per job, written atomically (tmp + rename). */
export class FileJobStore implements JobStore {
  private readonly dir: string;
  constructor(baseDir: string) {
    this.dir = join(baseDir, 'jobs');
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }
  loadAll(): JobRecord[] {
    const out: JobRecord[] = [];
    for (const f of readdirSync(this.dir)) {
      if (!FILE.test(f)) continue; // also skips *.tmp
      try {
        const r = JSON.parse(readFileSync(join(this.dir, f), 'utf8')) as JobRecord;
        if (typeof r.jobId === 'string' && `${r.jobId}.json` === f && typeof r.ownerId === 'string' && typeof r.idemHash === 'string') out.push(r);
      } catch {
        /* corrupt entry: ignored */
      }
    }
    return out;
  }
  save(rec: JobRecord): void {
    if (!FILE.test(`${rec.jobId}.json`)) throw new Error('invalid jobId');
    const final = join(this.dir, `${rec.jobId}.json`);
    const tmp = `${final}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(rec), { mode: 0o600 });
    renameSync(tmp, final);
  }
  remove(jobId: string): void {
    if (!FILE.test(`${jobId}.json`)) return;
    rmSync(join(this.dir, `${jobId}.json`), { force: true });
  }
}
