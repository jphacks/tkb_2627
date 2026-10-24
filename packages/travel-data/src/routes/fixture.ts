import type { TravelLeg } from '@tkb/contracts';
import { domesticTrip, overseasTrip } from '@tkb/fixtures';
import type { CallBudget } from '../policy/budget.ts';
import type { RouteProvider, RouteRequest, RouteResult } from './types.ts';

const FIXTURE_LEGS: readonly TravelLeg[] = [domesticTrip, overseasTrip].flatMap(t => t.days.flatMap(d => d.items)).filter((i): i is TravelLeg => i.type === 'leg');

/**
 * PROVIDER_MODE=fixture: legs from the B04 fixtures for the same segment and mode, labelled as fixture data.
 * No provider call, so the budget is not charged. Anything else is `no_route`; nothing is made up.
 */
export class FixtureRouteProvider implements RouteProvider {
  constructor(private readonly legs: readonly TravelLeg[] = FIXTURE_LEGS) {}

  async route(request: RouteRequest, budget: CallBudget): Promise<RouteResult> {
    void budget;
    const leg = this.legs.find(l => l.fromPlaceId === request.from.placeId && l.toPlaceId === request.to.placeId && l.mode === request.mode);
    return leg ? { leg: structuredClone(leg), reason: null } : { leg: null, reason: 'no_route' };
  }
}
