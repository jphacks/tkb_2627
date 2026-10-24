import type { PermittedFact, Provenance, UtcInstant } from '@tkb/contracts';

/**
 * What one provider allows us to do with its data. Until M1 decides from docs/provider-probe.md, Google data uses
 * M1's defaults (Issue #11): only the provider's place ID may be stored; nothing goes to the model or to exports.
 */
export interface SourcePolicy {
  source: string;
  attribution: string | null;
  /** Fields that may be persisted, with how long in seconds (null = no limit). Every other field is display-only. */
  storableFields: Readonly<Record<string, number | null>>;
  /** Whether the content as a whole may be persisted (Provenance.mayStore). */
  mayStore: boolean;
  maySendToModel: boolean;
  mayExport: boolean;
  /** How long fetched content may be kept for display, in seconds; 0 means only for the response that fetched it. */
  displayTtlSeconds: number;
}

export const DEFAULT_SOURCE_POLICIES: Readonly<Record<string, SourcePolicy>> = {
  google_places: {
    source: 'google_places',
    attribution: 'Google Maps',
    // Places API Policies: "the place ID ... is exempt from the caching restrictions" (docs/provider-probe.md).
    storableFields: { providerPlaceId: null },
    mayStore: false,
    maySendToModel: false,
    mayExport: false,
    displayTtlSeconds: 0,
  },
  google_routes: {
    source: 'google_routes',
    attribution: 'Google Maps',
    storableFields: {},
    mayStore: false,
    maySendToModel: false,
    mayExport: false,
    displayTtlSeconds: 0,
  },
  fixture: {
    source: 'fixture',
    attribution: 'tkb_2627 fixture',
    storableFields: { '*': null },
    mayStore: true,
    maySendToModel: true,
    mayExport: true,
    displayTtlSeconds: 0,
  },
};

export type FieldUse = 'store' | 'display_only';

function policyFor(source: string, policies: Readonly<Record<string, SourcePolicy>>): SourcePolicy {
  const policy = policies[source];
  if (!policy) throw new RangeError(`no data policy for source "${source}"`);
  return policy;
}

/** Whether a field from `source` may be persisted. An unknown source has no policy and is rejected. */
export function classifyField(source: string, field: string, policies = DEFAULT_SOURCE_POLICIES): FieldUse {
  const { storableFields } = policyFor(source, policies);
  return field in storableFields || '*' in storableFields ? 'store' : 'display_only';
}

const toUtc = (ms: number): UtcInstant => new Date(ms).toISOString().replace(/\.000Z$/, 'Z');

/**
 * Provenance for data fetched now from `source`. Content that may not be stored gets retainUntil = fetchedAt +
 * displayTtlSeconds, so purgeExpired drops it once it has been shown.
 */
export function provenanceFor(source: string, fetchedAtMs: number, policies = DEFAULT_SOURCE_POLICIES): Provenance {
  const p = policyFor(source, policies);
  return {
    source: p.source,
    fetchedAt: toUtc(fetchedAtMs),
    attribution: p.attribution,
    maySendToModel: p.maySendToModel,
    mayStore: p.mayStore,
    mayExport: p.mayExport,
    retainUntil: p.mayStore ? null : toUtc(fetchedAtMs + p.displayTtlSeconds * 1000),
  };
}

/** True once `retainUntil` has passed. No provenance (our own user data) never expires. */
export function isExpired(provenance: Provenance | null, nowMs: number): boolean {
  return provenance?.retainUntil != null && Date.parse(provenance.retainUntil) < nowMs;
}

/** Splits items into those still within their retention and those to drop (R30). */
export function purgeExpired<T extends { provenance: Provenance | null }>(items: readonly T[], nowMs: number): { kept: T[]; expired: T[] } {
  const kept: T[] = [];
  const expired: T[] = [];
  for (const item of items) (isExpired(item.provenance, nowMs) ? expired : kept).push(item);
  return { kept, expired };
}

/** Facts the model may see (docs/08: provider data never goes to the LLM unless allowed); a leg without provenance is our own data. */
export function factsForModel(facts: readonly PermittedFact[]): PermittedFact[] {
  return facts.filter(f => (f.kind === 'place' ? f.place.provenance.maySendToModel : (f.leg.provenance?.maySendToModel ?? true)));
}
