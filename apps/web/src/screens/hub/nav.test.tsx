import { renderToString as renderRaw } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { NavBar } from './NavBar.tsx';
import { REVIEW_LINKS } from './reviewLinks.ts';
import { backTarget, navModel, nextDepth, tripTabs } from './nav.ts';

const render = (hash: string, pathname = '/') => renderRaw(<NavBar hash={hash} pathname={pathname} />).replace(/<!-- -->/g, '');

describe('trip tabs', () => {
  it('keeps mode and trip id, in order', () => {
    expect(tripTabs('#/trips/t1/map').map((t) => t.href)).toEqual(['#/trips/t1/map', '#/trips/t1/edit', '#/trips/t1/travel', '#/trips/t1/guide']);
    expect(tripTabs('#/mock/trips/fx_trip_kanazawa/guide').map((t) => t.href)[0]).toBe('#/mock/trips/fx_trip_kanazawa/map');
    expect(tripTabs('#/mock/trips/x/edit').map((t) => t.label)).toEqual(['地図', '編集', '旅行中', 'ガイド']);
  });
  it('marks exactly the current tab', () => {
    for (const k of ['map', 'edit', 'travel', 'guide']) {
      const cur = tripTabs(`#/trips/t1/${k}`).filter((t) => t.current);
      expect(cur.map((t) => t.key)).toEqual([k]);
    }
    expect(render('#/mock/trips/t/guide').match(/aria-current="page"/g)).toHaveLength(1);
  });
  it('no tabs on non-trip screens', () => { expect(tripTabs('#generate')).toEqual([]); });
});

describe('NavBar', () => {
  it('is absent on home', () => {
    for (const h of ['', '#', '#home']) { expect(navModel(h).visible).toBe(false); expect(render(h)).toBe(''); }
  });
  it('shows titles on generate, conditions, social', () => {
    expect(render('#generate')).toContain('旅行の計画');
    expect(render('#conditions')).toContain('条件入力');
    expect(render('#social')).toContain('SNS・グループ');
  });
  it('has back and home controls', () => {
    const html = render('#social');
    expect(html).toContain('← 戻る');
    expect(html).toContain('href="#home"');
  });
  it('every review link gets a bar', () => {
    for (const l of REVIEW_LINKS) expect(render(l.href), l.href).toContain('class="nav-bar"');
  });
});

describe('back', () => {
  it('falls back to #home when there is no in-app history', () => {
    expect(backTarget(0)).toBe('#home');
    expect(backTarget(2)).toBe('history');
  });
  it('depth: push increments, pop restores', () => {
    expect(nextDepth(-1, undefined)).toBe(0);
    expect(nextDepth(0, undefined)).toBe(1);
    expect(nextDepth(3, 1)).toBe(1);
  });
});

describe('しおり is not offered (user decision on #37)', () => {
  it('no trip tab and no hub link point to the print screen', async () => {
    const { REVIEW_LINKS } = await import('./reviewLinks.ts');
    expect(tripTabs('#/trips/t1/map').some((t) => t.href.endsWith('/print') || t.label.includes('しおり'))).toBe(false);
    expect(REVIEW_LINKS.some((l) => l.href.endsWith('/print'))).toBe(false);
  });
});
