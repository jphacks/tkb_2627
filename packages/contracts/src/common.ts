import { z } from 'zod';

/**
 * Contract schema version. Bump only for breaking changes (see packages/contracts/README.md).
 * Additive, optional fields keep the same version.
 */
export const SCHEMA_VERSION = 1 as const;
export const SchemaVersion = z.literal(SCHEMA_VERSION);

export const Id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/, 'id must be [A-Za-z0-9_-]');
export type Id = z.infer<typeof Id>;

/** Calendar date in the trip's local time zone, e.g. 2026-11-01. */
export const LocalDate = z.iso.date();
export type LocalDate = z.infer<typeof LocalDate>;

/** Absolute instant in UTC, always with a trailing Z. */
export const UtcInstant = z.iso.datetime({ offset: false });
export type UtcInstant = z.infer<typeof UtcInstant>;

function isIanaTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return value.includes('/') || value === 'UTC';
  } catch {
    return false;
  }
}

/** IANA time zone such as Asia/Tokyo or Europe/Paris. Fixed offsets like +09:00 are rejected. */
export const TimeZone = z.string().refine(isIanaTimeZone, 'must be an IANA time zone');
export type TimeZone = z.infer<typeof TimeZone>;

/** A point in time that keeps both the UTC instant and the zone it should be displayed in (R07). */
export const ZonedTime = z.object({
  utc: UtcInstant,
  timeZone: TimeZone,
});
export type ZonedTime = z.infer<typeof ZonedTime>;

/** ISO 4217 code. Amounts are integers in the currency's minor unit (JPY has none, EUR has cents). */
export const CurrencyCode = z.string().regex(/^[A-Z]{3}$/, 'must be an ISO 4217 code');
export const Money = z.object({
  amountMinor: z.number().int(),
  currency: CurrencyCode,
});
export type Money = z.infer<typeof Money>;
/** Costs and fares are never negative; deltas use plain Money. */
export const NonNegativeMoney = Money.extend({ amountMinor: z.number().int().nonnegative() });

/**
 * Unknown values are represented by `null`, never by 0 or an invented value.
 * `dataStatus` explains where a value came from.
 */
export const DataStatus = z.enum(['verified', 'fixture', 'unknown', 'unavailable', 'unsupported_region']);
export type DataStatus = z.infer<typeof DataStatus>;

export const DataMode = z.enum(['fixture', 'live', 'mixed']);
export type DataMode = z.infer<typeof DataMode>;

/** Where external data came from and what we may do with it (docs/08_POLICY_AND_COST.md). */
export const Provenance = z.object({
  source: z.string().min(1),
  fetchedAt: UtcInstant.nullable(),
  attribution: z.string().nullable(),
  maySendToModel: z.boolean(),
  mayStore: z.boolean(),
  mayExport: z.boolean(),
  retainUntil: UtcInstant.nullable(),
});
export type Provenance = z.infer<typeof Provenance>;

export const LatLng = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});
export type LatLng = z.infer<typeof LatLng>;

export const TransportMode = z.enum(['transit', 'car']);
export type TransportMode = z.infer<typeof TransportMode>;

export const Visibility = z.enum(['private', 'group', 'public']);
export type Visibility = z.infer<typeof Visibility>;
