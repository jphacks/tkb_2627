import { Trip } from '@tkb/contracts';
import type { Db } from './index.ts';

/**
 * Runs `fn` inside BEGIN IMMEDIATE ... COMMIT; any exception rolls back and is rethrown.
 * Nesting is forbidden (throws). Keep `fn` short and synchronous: never await an external API,
 * the AI runner, or any network call inside it, because the write lock is held until COMMIT (K20).
 * Do the slow work first, then open the transaction only to persist the result.
 */
// Tracked here instead of DatabaseSync#isTransaction, which only exists from Node 24.
const active = new WeakSet<Db>();

export function isInTransaction(db: Db): boolean {
  return active.has(db);
}

export function transaction<T>(db: Db, fn: () => T): T {
  if (active.has(db)) throw new Error('nested transaction is not allowed');
  db.exec('BEGIN IMMEDIATE');
  active.add(db);
  let committed = false;
  try {
    const result = fn();
    if (result instanceof Promise) throw new Error('transaction fn must be synchronous');
    db.exec('COMMIT');
    committed = true;
    return result;
  } finally {
    if (!committed) {
      // SQLite may already have rolled back on its own; never let that mask the original error.
      try {
        db.exec('ROLLBACK');
      } catch {
        /* already rolled back */
      }
    }
    active.delete(db);
  }
}

export interface NewUser {
  id: string;
  loginId: string;
  /** Already hashed by the caller (S02). Plaintext passwords are never accepted here. */
  passwordHash: string;
  displayName: string;
  createdAt: string;
}

export function createUser(db: Db, user: NewUser): void {
  db.prepare(
    'INSERT INTO users (id, login_id, password_hash, display_name, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(user.id, user.loginId, user.passwordHash, user.displayName, user.createdAt);
}

interface TripRow {
  id: string;
  owner_id: string;
  schema_version: number;
  title: string;
  revision: number;
  constraints_json: string;
  days_json: string;
  places_json: string;
  warnings_json: string;
  validation_state: string;
  created_at: string;
  updated_at: string;
}

function insertVersion(db: Db, trip: Trip): void {
  // trip.updatedAt is always the server time set by insertTrip/updateTripWithRevision.
  db.prepare(
    'INSERT INTO trip_versions (trip_id, revision, document_json, created_at) VALUES (?, ?, ?, ?)',
  ).run(trip.tripId, trip.revision, JSON.stringify(trip), trip.updatedAt);
}

/**
 * Inserts a new trip at revision 1 plus its trip_versions row in one transaction.
 * `ownerId` must come from the authenticated session; `input.ownerId` is ignored.
 * `now` is the server clock (UTC ISO with Z); client timestamps are ignored.
 */
export function insertTrip(db: Db, ownerId: string, input: Trip, now: string): Trip {
  const trip = Trip.parse({ ...input, ownerId, revision: 1, createdAt: now, updatedAt: now });
  transaction(db, () => {
    db.prepare(
      `INSERT INTO trips (id, owner_id, schema_version, title, revision, constraints_json, days_json,
        places_json, warnings_json, validation_state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      trip.tripId,
      trip.ownerId,
      trip.schemaVersion,
      trip.title,
      trip.revision,
      JSON.stringify(trip.constraints),
      JSON.stringify(trip.days),
      JSON.stringify(trip.places),
      JSON.stringify(trip.warnings),
      trip.validationState,
      trip.createdAt,
      trip.updatedAt,
    );
    insertVersion(db, trip);
  });
  return trip;
}

/** Returns null for missing, deleted, or other owners' trips so existence is never leaked. */
export function getTripForOwner(db: Db, tripId: string, ownerId: string): Trip | null {
  const row = db
    .prepare('SELECT * FROM trips WHERE id = ? AND owner_id = ? AND deleted_at IS NULL')
    .get(tripId, ownerId) as TripRow | undefined;
  if (!row) return null;
  return Trip.parse({
    schemaVersion: row.schema_version,
    tripId: row.id,
    ownerId: row.owner_id,
    title: row.title,
    revision: row.revision,
    constraints: JSON.parse(row.constraints_json),
    days: JSON.parse(row.days_json),
    places: JSON.parse(row.places_json),
    validationState: row.validation_state,
    warnings: JSON.parse(row.warnings_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

export type UpdateTripResult =
  | { ok: true; revision: number; trip: Trip }
  | { ok: false; code: 'REVISION_CONFLICT'; currentRevision: number }
  | { ok: false; code: 'NOT_FOUND' };

/**
 * Optimistic update: succeeds only if the stored revision equals `expectedRevision`. The new
 * revision is expectedRevision + 1 (`trip.revision` is ignored). `ownerId` must come from the
 * session; `trip.ownerId` and `trip.createdAt` are ignored and `now` becomes updatedAt.
 */
export function updateTripWithRevision(
  db: Db,
  ownerId: string,
  trip: Trip,
  expectedRevision: number,
  now: string,
): UpdateTripResult {
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) throw new Error('expectedRevision must be a positive integer');
  const next = Trip.parse({ ...trip, ownerId, revision: expectedRevision + 1, updatedAt: now });
  return transaction(db, (): UpdateTripResult => {
    const res = db
      .prepare(
        `UPDATE trips SET schema_version = ?, title = ?, revision = ?, constraints_json = ?, days_json = ?,
          places_json = ?, warnings_json = ?, validation_state = ?, updated_at = ?
         WHERE id = ? AND owner_id = ? AND revision = ? AND deleted_at IS NULL`,
      )
      .run(
        next.schemaVersion,
        next.title,
        next.revision,
        JSON.stringify(next.constraints),
        JSON.stringify(next.days),
        JSON.stringify(next.places),
        JSON.stringify(next.warnings),
        next.validationState,
        next.updatedAt,
        next.tripId,
        next.ownerId,
        expectedRevision,
      );
    if (Number(res.changes) === 0) {
      const cur = db
        .prepare('SELECT revision FROM trips WHERE id = ? AND owner_id = ? AND deleted_at IS NULL')
        .get(next.tripId, next.ownerId) as { revision: number } | undefined;
      return cur
        ? { ok: false, code: 'REVISION_CONFLICT', currentRevision: cur.revision }
        : { ok: false, code: 'NOT_FOUND' };
    }
    // createdAt never changes on update: take it from the row so the version document and the
    // returned Trip are identical (the caller's createdAt is ignored).
    const stored = db.prepare('SELECT created_at FROM trips WHERE id = ?').get(next.tripId) as { created_at: string };
    const saved: Trip = { ...next, createdAt: stored.created_at };
    insertVersion(db, saved);
    return { ok: true, revision: saved.revision, trip: saved };
  });
}
