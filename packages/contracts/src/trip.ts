import { z } from 'zod';
import {
  DataStatus,
  Id,
  LatLng,
  LocalDate,
  Money,
  NonNegativeMoney,
  Provenance,
  SchemaVersion,
  TimeZone,
  TransportMode,
  UtcInstant,
  ZonedTime,
} from './common.ts';

export const PlaceKind = z.enum(['spot', 'restaurant', 'area', 'station', 'lodging', 'toilet', 'shelter', 'other']);

export const Photo = z.object({
  url: z.url(),
  attribution: z.string().min(1),
  license: z.string().nullable(),
});
export type Photo = z.infer<typeof Photo>;

/** K06: normalized place. Opening hours are free text from the provider or null when unknown. */
export const PlaceInfo = z.object({
  placeId: Id,
  name: z.string().min(1),
  kind: PlaceKind,
  location: LatLng.nullable(),
  timeZone: TimeZone,
  openingHours: z.string().nullable(),
  description: z.string().nullable(),
  photo: Photo.nullable(),
  dataStatus: DataStatus,
  provenance: Provenance,
});
export type PlaceInfo = z.infer<typeof PlaceInfo>;

/**
 * R13: `meal` is a visit to a fixed restaurant, `free_walk` is area-level wandering without a fixed venue.
 * `fixed` marks reservations and other items replanning must not move (R12).
 */
export const ActivityKind = z.enum(['visit', 'meal', 'free_walk', 'lodging', 'custom']);
export const ActivityStatus = z.enum(['planned', 'completed', 'skipped']);

export const Activity = z.object({
  type: z.literal('activity'),
  activityId: Id,
  kind: ActivityKind,
  title: z.string().min(1),
  placeId: Id.nullable(),
  areaName: z.string().nullable(),
  start: ZonedTime.nullable(),
  end: ZonedTime.nullable(),
  fixed: z.boolean(),
  status: ActivityStatus,
  cost: NonNegativeMoney.nullable(),
  /** Where `cost` came from; `unknown` when cost is null. */
  costStatus: DataStatus,
  /** Never copied into SNS snapshots. */
  privateNotes: z.string().nullable(),
});
export type Activity = z.infer<typeof Activity>;

export const LegMode = z.enum(['transit', 'car', 'walk']);

/** K06: a travel segment. Fare, platform and times stay null unless a provider returned them. */
export const TravelLeg = z.object({
  type: z.literal('leg'),
  legId: Id,
  mode: LegMode,
  fromPlaceId: Id,
  toPlaceId: Id,
  departure: ZonedTime.nullable(),
  arrival: ZonedTime.nullable(),
  durationSeconds: z.number().int().nonnegative().nullable(),
  lineName: z.string().nullable(),
  platform: z.string().nullable(),
  transfers: z.number().int().nonnegative().nullable(),
  fare: NonNegativeMoney.nullable(),
  dataStatus: DataStatus,
  provenance: Provenance.nullable(),
});
export type TravelLeg = z.infer<typeof TravelLeg>;

/**
 * Public view of an activity for SNS snapshots: an explicit allow-list (pick), so fields added to
 * Activity later are not published by accident.
 */
export const PublicActivity = Activity.pick({
  type: true,
  activityId: true,
  kind: true,
  title: true,
  placeId: true,
  areaName: true,
  start: true,
  end: true,
  fixed: true,
  status: true,
  cost: true,
  costStatus: true,
});
export type PublicActivity = z.infer<typeof PublicActivity>;

export const ItineraryItem = z.discriminatedUnion('type', [Activity, TravelLeg]);
export type ItineraryItem = z.infer<typeof ItineraryItem>;

export const TripDay = z.object({
  date: LocalDate,
  timeZone: TimeZone,
  items: z.array(ItineraryItem),
});
export type TripDay = z.infer<typeof TripDay>;

export const PublicTripDay = z.object({
  date: LocalDate,
  timeZone: TimeZone,
  items: z.array(z.discriminatedUnion('type', [PublicActivity, TravelLeg])),
});
export type PublicTripDay = z.infer<typeof PublicTripDay>;

export const Endpoint = z.object({
  placeId: Id.nullable(),
  label: z.string().nullable(),
  time: ZonedTime.nullable(),
});

/** R01: trip conditions. Only area, dates, time zone and mode are required; nothing is silently defaulted. */
const TripConstraintsBase = z.object({
  area: z.string().min(1).max(200),
  startDate: LocalDate,
  endDate: LocalDate,
  timeZone: TimeZone,
  transportMode: TransportMode,
  budget: Money.nullable().optional(),
  mustVisit: z.array(Id).max(30).optional(),
  departure: Endpoint.optional(),
  return: Endpoint.optional(),
  preferences: z.array(z.string().max(200)).max(20).optional(),
});
export const TripConstraints = TripConstraintsBase.refine(c => c.endDate >= c.startDate, {
  message: 'endDate must not be before startDate',
  path: ['endDate'],
});
export type TripConstraints = z.infer<typeof TripConstraints>;

/**
 * Conditions safe to publish. departure/return may contain a home address and budget is private,
 * so SNS snapshots use this allow-list instead of TripConstraints.
 */
export const PublicTripConstraints = TripConstraintsBase.pick({
  area: true,
  startDate: true,
  endDate: true,
  timeZone: true,
  transportMode: true,
});
export type PublicTripConstraints = z.infer<typeof PublicTripConstraints>;

export const ValidationState = z.enum(['valid', 'needs_review', 'needs_revalidation', 'invalid']);
export type ValidationState = z.infer<typeof ValidationState>;

/** K09: the stored trip. ownerId is always set by the server from the session. */
export const Trip = z.object({
  schemaVersion: SchemaVersion,
  tripId: Id,
  ownerId: Id,
  title: z.string().min(1).max(200),
  revision: z.number().int().positive(),
  constraints: TripConstraints,
  days: z.array(TripDay),
  places: z.array(PlaceInfo),
  validationState: ValidationState,
  warnings: z.array(z.string()),
  createdAt: UtcInstant,
  updatedAt: UtcInstant,
});
export type Trip = z.infer<typeof Trip>;

export const TripSummary = Trip.pick({
  tripId: true,
  title: true,
  revision: true,
  validationState: true,
  updatedAt: true,
}).extend({ area: z.string(), startDate: LocalDate, endDate: LocalDate });
export type TripSummary = z.infer<typeof TripSummary>;
