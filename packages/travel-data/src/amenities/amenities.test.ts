import { Provenance } from '@tkb/contracts';
import { describe, expect, it } from 'vitest';
import { PolicyError } from '../policy/budget.ts';
import { FixtureAmenitiesProvider, FIXTURE_AMENITIES } from './fixture.ts';
import { LiveAmenitiesProvider } from './live.ts';
import { GSI_SHELTER_SOURCE } from './source.ts';
import { OPENING_STATUS_WARNING } from './types.ts';

const KANAZAWA = { south: 36.55, west: 136.64, north: 36.59, east: 136.68 };
const p = new FixtureAmenitiesProvider();

describe('amenities (D08)', () => {
  it('separates evacuation sites, shelters and toilets', async () => {
    const r = await p.search({ bbox: KANAZAWA });
    expect(new Set(r.items.map(i => i.kind))).toEqual(new Set(['toilet', 'evacuation_site', 'evacuation_shelter']));
    const sites = await p.search({ bbox: KANAZAWA, kinds: ['evacuation_site'] });
    expect(sites.items.every(i => i.kind === 'evacuation_site')).toBe(true);
    expect(sites.items.length).toBe(2);
    expect(r.dataStatus).toBe('fixture');
    expect(r.fetchedAt).not.toBeNull();
  });

  it('keeps hazard flags unknown (null) apart from false and filters only on true', async () => {
    const r = await p.search({ bbox: KANAZAWA, kinds: ['evacuation_site'] });
    const park = r.items.find(i => i.id === 'fx-site-1')!;
    expect(park.hazards!.flood).toBe(false);
    expect(park.hazards!.volcano).toBeNull();
    expect(park.hazards!.earthquake).toBe(true);
    const tsunami = await p.search({ bbox: KANAZAWA, hazard: 'tsunami' });
    expect(tsunami.items.map(i => i.id)).toEqual(['fx-site-2']);
    const volcano = await p.search({ bbox: KANAZAWA, hazard: 'volcano' });
    expect(volcano.items).toEqual([]);
    expect(volcano.dataStatus).toBe('fixture');
  });

  it('toilets: accessible unknown stays null and hours are null', async () => {
    const r = await p.search({ bbox: KANAZAWA, kinds: ['toilet'] });
    expect(r.items.find(i => i.id === 'fx-toilet-2')!.accessible).toBeNull();
    expect(r.items.find(i => i.id === 'fx-toilet-1')!.accessible).toBe(true);
    expect(r.items.every(i => i.openingHours === null)).toBe(true);
  });

  it('abroad and uncovered Japan are unsupported_region, not empty', async () => {
    const paris = await p.search({ bbox: { south: 48.85, west: 2.3, north: 48.87, east: 2.35 } });
    expect(paris.dataStatus).toBe('unsupported_region');
    expect(paris.reason).toMatch(/国外/);
    const tokyo = await p.search({ bbox: { south: 35.67, west: 139.7, north: 35.69, east: 139.75 } });
    expect(tokyo.dataStatus).toBe('unsupported_region');
  });

  it('distinguishes an empty covered area from a failure', async () => {
    const empty = await p.search({ bbox: { south: 36.6, west: 136.7, north: 36.61, east: 136.71 } });
    expect(empty.items).toEqual([]);
    expect(empty.dataStatus).toBe('fixture');
    const live = await new LiveAmenitiesProvider().search();
    expect(live.items).toEqual([]);
    expect(live.dataStatus).toBe('unavailable');
    expect(live.reason).toMatch(/未実装/);
  });

  it('rejects a too-large or invalid range with VALIDATION_FAILED', async () => {
    const big = p.search({ bbox: { south: 36.0, west: 136.0, north: 37.0, east: 137.0 } });
    await expect(big).rejects.toBeInstanceOf(PolicyError);
    await expect(big).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(p.search({ bbox: KANAZAWA, hazard: 'meteor' as never })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(p.search({ bbox: KANAZAWA, kinds: ['bar' as never] })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('provenance is valid and conservative', () => {
    for (const i of FIXTURE_AMENITIES) {
      expect(Provenance.safeParse(i.provenance).success).toBe(true);
      expect(i.provenance.maySendToModel).toBe(false);
      expect(i.provenance.mayExport).toBe(false);
      expect(i.provenance.mayStore).toBe(true);
      expect(i.name).toContain('架空');
    }
    expect(GSI_SHELTER_SOURCE.liveImplemented).toBe(false);
    expect(GSI_SHELTER_SOURCE.attribution).toMatch(/国土地理院/);
  });

  it('never claims a facility is open now', async () => {
    const r = await p.search({ bbox: KANAZAWA });
    for (const i of r.items) {
      expect(i.openNow).toBeNull();
      expect(i.warning).toBe(OPENING_STATUS_WARNING);
    }
  });
});
