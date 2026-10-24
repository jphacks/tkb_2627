import { SCHEMA_VERSION, type GenerationInput, type PermittedFact, type PlanningContext, type TripConstraints } from '@tkb/contracts';
import { VISITABLE_KINDS } from './collect.ts';

export const INSTRUCTIONS =
  'Propose up to 3 candidate itineraries as a structured plan blueprint. Order only the allowed place IDs in activityOrder, ' +
  'include every must-visit place, and never invent places, opening hours, fares or travel times. ' +
  'Write reasons and warnings briefly in Japanese.';

/** Same rule as factsForModel in @tkb/travel-data: provider data goes to the model only when its provenance allows it; our own legs (no provenance) may. */
export const mayGoToModel = (f: PermittedFact): boolean => (f.kind === 'place' ? f.place.provenance.maySendToModel : (f.leg.provenance?.maySendToModel ?? true));

export function toGenerationInput(constraints: TripConstraints, ctx: PlanningContext): GenerationInput {
  const facts: PermittedFact[] = [
    ...ctx.places.map((place): PermittedFact => ({ kind: 'place', place })),
    ...ctx.legs.map((leg): PermittedFact => ({ kind: 'leg', leg })),
  ].filter(mayGoToModel);
  return {
    schemaVersion: SCHEMA_VERSION,
    constraints,
    // Ids may go to the model even when the place's content may not (M1 on #28, D-2); the facts above are filtered.
    allowedPlaceIds: ctx.places.filter(p => VISITABLE_KINDS.has(p.kind)).map(p => p.placeId),
    facts,
    fixedActivities: [],
    instructions: INSTRUCTIONS,
  };
}
