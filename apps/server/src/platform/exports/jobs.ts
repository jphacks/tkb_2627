import { randomUUID } from 'node:crypto';
import type { ExportWithheld } from '@tkb/contracts';

/**
 * E02: a small in-memory job queue for PDF exports on the shared server. It is NOT the Claude generation queue (K18).
 * - `concurrency` jobs run at once (default 1); at most `maxPending` wait (QUEUE_FULL beyond that).
 * - One job per user may be queued or running at a time (RATE_LIMITED otherwise).
 * - A job taking longer than `timeoutMs` (default 20 s) becomes `failed` (TIMEOUT); its slot is released.
 * - A finished file is kept in memory for `ttlMs` (default 10 min) and then dropped (`expired`); expired and failed
 *   records are forgotten after another `ttlMs`. Nothing is written to disk and a restart forgets every export.
 * - Records are bound to the owner: lookups by another user behave as missing.
 */

export interface ExportJobOptions {
  concurrency?: number;
  maxPending?: number;
  timeoutMs?: number;
  ttlMs?: number;
  /** Most finished exports kept per user; older ones are dropped first. */
  maxKeptPerUser?: number;
  now?: () => number;
}

export type ExportState = 'queued' | 'running' | 'ready' | 'failed' | 'expired';

export interface ExportRecord {
  exportId: string;
  ownerId: string;
  tripId: string;
  filename: string;
  state: ExportState;
  withheld: ExportWithheld[];
  bytes: Uint8Array | null;
  error: { code: string; message: string } | null;
  createdAt: number;
  /** When the file (ready) or the record (expired/failed) is dropped. */
  expiresAt: number | null;
}

export type Render = () => Promise<Uint8Array>;
export type EnqueueResult = { ok: true; record: ExportRecord } | { ok: false; code: 'RATE_LIMITED' | 'QUEUE_FULL' };

export class ExportJobs {
  private readonly records = new Map<string, ExportRecord>();
  private readonly pending: { record: ExportRecord; render: Render }[] = [];
  private running = 0;
  private readonly concurrency: number;
  private readonly maxPending: number;
  private readonly timeoutMs: number;
  private readonly ttlMs: number;
  private readonly maxKeptPerUser: number;
  private readonly now: () => number;
  private readonly idle = new Set<() => void>();

  constructor(opts: ExportJobOptions = {}) {
    this.concurrency = Math.min(Math.max(opts.concurrency ?? 1, 1), 2);
    this.maxPending = opts.maxPending ?? 8;
    this.timeoutMs = opts.timeoutMs ?? 20_000;
    this.ttlMs = opts.ttlMs ?? 10 * 60_000;
    this.maxKeptPerUser = opts.maxKeptPerUser ?? 5;
    this.now = opts.now ?? Date.now;
  }

  enqueue(ownerId: string, tripId: string, filename: string, withheld: ExportWithheld[], render: Render): EnqueueResult {
    this.sweep();
    const mine = [...this.records.values()].filter((r) => r.ownerId === ownerId);
    if (mine.some((r) => r.state === 'queued' || r.state === 'running')) return { ok: false, code: 'RATE_LIMITED' };
    if (this.pending.length >= this.maxPending) return { ok: false, code: 'QUEUE_FULL' };
    const kept = mine.filter((r) => r.state !== 'expired').sort((a, b) => a.createdAt - b.createdAt);
    while (kept.length >= this.maxKeptPerUser) this.records.delete(kept.shift()!.exportId);
    const record: ExportRecord = {
      exportId: `export_${randomUUID().replace(/-/g, '')}`,
      ownerId,
      tripId,
      filename,
      state: 'queued',
      withheld,
      bytes: null,
      error: null,
      createdAt: this.now(),
      expiresAt: null,
    };
    this.records.set(record.exportId, record);
    this.pending.push({ record, render });
    this.pump();
    return { ok: true, record };
  }

  /** The record if it exists and belongs to `ownerId`; null otherwise (not found and not yours look the same). */
  get(exportId: string, ownerId: string): ExportRecord | null {
    this.sweep();
    const r = this.records.get(exportId);
    return r && r.ownerId === ownerId ? r : null;
  }

  delete(exportId: string, ownerId: string): boolean {
    const r = this.get(exportId, ownerId);
    if (!r) return false;
    this.records.delete(exportId);
    const i = this.pending.findIndex((p) => p.record === r);
    if (i >= 0) this.pending.splice(i, 1);
    return true;
  }

  /** Resolves when nothing is queued or running (tests). */
  whenIdle(): Promise<void> {
    if (this.running === 0 && this.pending.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.idle.add(resolve));
  }

  private sweep(): void {
    const t = this.now();
    for (const r of this.records.values()) {
      if (r.expiresAt === null || r.expiresAt > t) continue;
      if (r.state === 'ready') {
        r.state = 'expired';
        r.bytes = null;
        r.expiresAt = t + this.ttlMs;
      } else {
        this.records.delete(r.exportId);
      }
    }
  }

  private pump(): void {
    while (this.running < this.concurrency && this.pending.length > 0) {
      const { record, render } = this.pending.shift()!;
      this.running += 1;
      record.state = 'running';
      void this.run(record, render).finally(() => {
        this.running -= 1;
        this.pump();
        if (this.running === 0 && this.pending.length === 0) {
          for (const resolve of this.idle) resolve();
          this.idle.clear();
        }
      });
    }
  }

  private async run(record: ExportRecord, render: Render): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), this.timeoutMs);
    });
    try {
      const out = await Promise.race([render(), timeout]);
      if (out === 'timeout') {
        record.state = 'failed';
        record.error = { code: 'TIMEOUT', message: 'PDF generation timed out.' };
      } else {
        record.state = 'ready';
        record.bytes = out;
      }
    } catch {
      // No stack or message from the renderer is kept or returned.
      record.state = 'failed';
      record.error = { code: 'INTERNAL', message: 'PDF generation failed.' };
    } finally {
      clearTimeout(timer);
      record.expiresAt = this.now() + this.ttlMs;
    }
  }
}
