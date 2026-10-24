import { renderToString as renderRaw } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TimeZone, type Capabilities } from '@tkb/contracts';
import { ConditionsView, type ConditionsViewProps } from './ConditionsScreen.tsx';
import { buildConditionsRequest, sampleConditions } from './model.ts';
import { COMMON_ZONES, buildZoneGroups, zoneForArea } from './tz.ts';

const caps: Capabilities = {
  entry: 'personal',
  aiGeneration: { available: true, runner: 'fake', reason: null },
  storage: 'shared-server',
  dataMode: 'fixture',
  schemaVersion: 1,
};
const noop = () => undefined;
const base: ConditionsViewProps = {
  form: sampleConditions, onChange: noop, onSubmit: noop, onSearch: noop, searchArea: '', onSearchAreaChange: noop,
  search: { status: 'idle' }, capability: { status: 'done', data: caps }, submitted: false, busy: false, submitError: null,
  accepted: null, source: 'mock', now: new Date('2026-11-01T00:00:00Z'),
};

describe('U03 time zone picker', () => {
  it('lists common zones first with city, IANA name and UTC offset; every value is a valid IANA zone', () => {
    const groups = buildZoneGroups(new Date('2026-12-01T00:00:00Z'));
    expect(groups[0]!.label).toBe('よく使う');
    expect(groups[0]!.zones.map(z => z.value)).toEqual([...COMMON_ZONES]);
    expect(groups[0]!.zones[0]!.label).toBe('東京（Asia/Tokyo, UTC+9）');
    expect(groups[0]!.zones.find(z => z.value === 'America/New_York')!.label).toBe('ニューヨーク（America/New_York, UTC-5）');
    expect(groups.length).toBeGreaterThan(3);
    for (const g of groups) for (const o of g.zones) {
      expect(TimeZone.safeParse(o.value).success, o.value).toBe(true);
      expect(o.label).toContain(o.value);
      expect(o.label).toContain('UTC');
    }
  });

  it('maps an area to a known zone', () => {
    expect(zoneForArea('金沢')).toBe('Asia/Tokyo');
    expect(zoneForArea('パリ')).toBe('Europe/Paris');
    expect(zoneForArea('フランス')).toBe('Europe/Paris');
    expect(zoneForArea('Atlantis')).toBeNull();
  });

  it('renders a select (no datalist) and shows the chosen zone under it', () => {
    const html = renderRaw(<ConditionsView {...base} />).replace(/<!-- -->/g, '');
    expect(html).toContain('<select id="u3-tz"');
    expect(html).not.toContain('datalist');
    expect(html).toContain('<optgroup label="よく使う">');
    expect(html).toContain('選択中: 東京（Asia/Tokyo, UTC+9）');
  });

  it('keeps the request body timeZone a plain IANA string', () => {
    const r = buildConditionsRequest({ ...sampleConditions, base: { ...sampleConditions.base, timeZone: 'Europe/Paris' } });
    expect(r.request?.constraints.timeZone).toBe('Europe/Paris');
  });
});
