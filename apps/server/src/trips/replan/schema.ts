import { ReplanRequest } from '@tkb/contracts';

/**
 * POST /api/v1/trips/:id/replan (A06, Issue #30). The shapes live in @tkb/contracts (K10 extension in
 * docs/03_CONTRACTS.md) and are re-exported here for existing imports. The client never sends the time.
 */
export type {
  ReplanCandidate,
  ReplanConflictReason as ConflictReason,
  ReplanLocation,
  ReplanRequest,
  ReplanResult,
  ReplanStartKind as StartKind,
} from '@tkb/contracts';

/** Strict body: unknown keys are refused. null means invalid (422 VALIDATION_FAILED). */
export function parseReplanRequest(raw: unknown): ReplanRequest | null {
  const r = ReplanRequest.safeParse(raw);
  return r.success ? r.data : null;
}
