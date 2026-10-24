import { randomUUID } from 'node:crypto';
import { PlanBlueprint } from '@tkb/contracts';
import type { SafeError } from './runner.ts';

export type ParseResult = { ok: true; blueprint: PlanBlueprint } | { ok: false; error: SafeError };

function fail(message: string): ParseResult {
  return { ok: false, error: { code: 'INVALID_OUTPUT', message, retryable: true, requestId: randomUUID() } };
}

/** Verifies structured_output shape and rejects any place ID outside allowedPlaceIds. */
export function parseBlueprint(envelope: unknown, allowedPlaceIds: readonly string[]): ParseResult {
  if (typeof envelope !== 'object' || envelope === null || !('structured_output' in envelope)) {
    return fail('Output has no structured_output.');
  }
  const parsed = PlanBlueprint.safeParse((envelope as { structured_output: unknown }).structured_output);
  if (!parsed.success) return fail('Output does not match the plan schema.');
  const allowed = new Set(allowedPlaceIds);
  for (const c of parsed.data.candidates) {
    for (const id of [...c.activityOrder, ...(c.excludedPlaceIds ?? [])]) {
      if (!allowed.has(id)) return fail('Output references a place that was not provided.');
    }
  }
  return { ok: true, blueprint: parsed.data };
}
