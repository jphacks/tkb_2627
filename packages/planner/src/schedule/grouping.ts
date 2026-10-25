import type { Activity, PlaceInfo, TripDay, ZonedTime } from '@tkb/contracts';
import { parseUtc } from '../time/zone.ts';

/** About 5 minutes on foot (#32 R4): activities this close in a row belong to one area. */
export const NEARBY_WALK_METERS = 400;

export interface ActivityGroup {
  parentActivityId: string;
  childActivityIds: string[];
}

export interface GroupingResult {
  day: TripDay;
  groups: ActivityGroup[];
  /** Runs that should be one area but were left as they are, with why. */
  skipped: { activityIds: string[]; reason: 'no_area_activity' | 'fixed_parent_too_short' }[];
}

function meters(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * 6_371_008.8 * Math.asin(Math.min(1, Math.sqrt(h)));
}

const toUtc = (ms: number) => new Date(ms).toISOString().replace(/\.000Z$/, 'Z');

/**
 * #32 R4: consecutive top-level activities that are within NEARBY_WALK_METERS of each other, or share an area name,
 * become one area: the area-level activity (a free walk or a place of kind 'area') is the parent and the others get
 * its `parentActivityId`. The parent's window is widened to cover its children unless it is fixed (then the run is
 * left alone and reported). Unknown times do not block grouping (live walking legs often have no duration): only the
 * known times are compared, and a missing time is never filled in. Legs between two members of a group are dropped: travel is made per parent.
 * Runs without an area-level activity are reported, not invented into a new parent. Deterministic; one level only.
 */
export function groupNearby(day: TripDay, places: readonly PlaceInfo[], thresholdMeters = NEARBY_WALK_METERS): GroupingResult {
  const byId = new Map(places.map(p => [p.placeId, p]));
  const where = (a: Activity) => (a.placeId ? (byId.get(a.placeId)?.location ?? null) : null);
  const isArea = (a: Activity) => a.kind === 'free_walk' || (a.placeId !== null && byId.get(a.placeId)?.kind === 'area');
  const top = day.items.filter((i): i is Activity => i.type === 'activity' && !i.parentActivityId && i.status !== 'skipped');
  const hasChildren = new Set(day.items.flatMap(i => (i.type === 'activity' && i.parentActivityId ? [i.parentActivityId] : [])));

  const near = (a: Activity, b: Activity) => {
    if (a.areaName && b.areaName && a.areaName === b.areaName) return true;
    const pa = where(a);
    const pb = where(b);
    return pa !== null && pb !== null && meters(pa, pb) <= thresholdMeters;
  };

  // Runs of consecutive top-level activities, each near some member of the run (chained: A-B-C stays one area even if
  // A and C are farther apart, as a walk through one district).
  const runs: Activity[][] = [];
  for (const a of top) {
    const run = runs.at(-1);
    if (run && run.some(r => near(r, a))) run.push(a);
    else runs.push([a]);
  }

  const parentOf = new Map<string, string>();
  const newTimes = new Map<string, { start: ZonedTime; end: ZonedTime }>();
  const groups: ActivityGroup[] = [];
  const skipped: GroupingResult['skipped'] = [];
  for (const run of runs) {
    if (run.length < 2) continue;
    const ids = run.map(a => a.activityId);
    const parent = run.find(isArea);
    if (!parent) {
      skipped.push({ activityIds: ids, reason: 'no_area_activity' });
      continue;
    }
    const children = run.filter(a => a !== parent && !hasChildren.has(a.activityId));
    if (children.length === 0) continue;
    const members = [parent, ...children];
    // Only known times take part; an unknown time stays unknown (never guessed).
    const timed = members.filter(a => a.start !== null && a.end !== null);
    const parentTimed = parent.start !== null && parent.end !== null;
    if (parentTimed && timed.length > 1) {
      const startMs = Math.min(...timed.map(a => parseUtc(a.start!.utc)));
      const endMs = Math.max(...timed.map(a => parseUtc(a.end!.utc)));
      const covers = parseUtc(parent.start!.utc) <= startMs && parseUtc(parent.end!.utc) >= endMs;
      if (!covers && parent.fixed) {
        skipped.push({ activityIds: ids, reason: 'fixed_parent_too_short' });
        continue;
      }
      if (!covers) {
        newTimes.set(parent.activityId, { start: { ...parent.start!, utc: toUtc(startMs) }, end: { ...parent.end!, utc: toUtc(endMs) } });
      }
    }
    for (const c of children) parentOf.set(c.activityId, parent.activityId);
    groups.push({ parentActivityId: parent.activityId, childActivityIds: children.map(c => c.activityId) });
  }

  // Drop legs whose both ends are places of the same group (walking inside the area).
  const groupPlaces = groups.map(g => {
    const ids = new Set([g.parentActivityId, ...g.childActivityIds]);
    return new Set(top.filter(a => ids.has(a.activityId) && a.placeId).map(a => a.placeId!));
  });
  const insideOneGroup = (from: string, to: string) => groupPlaces.some(set => set.has(from) && set.has(to));

  const items = day.items.flatMap((item): TripDay['items'] => {
    if (item.type === 'leg') return insideOneGroup(item.fromPlaceId, item.toPlaceId) ? [] : [item];
    const parentActivityId = parentOf.get(item.activityId);
    const times = newTimes.get(item.activityId);
    if (!parentActivityId && !times) return [item];
    return [{ ...item, ...(parentActivityId ? { parentActivityId } : {}), ...(times ?? {}) }];
  });
  return { day: { ...day, items }, groups, skipped };
}
