import { describe, expect, it } from 'vitest';
import { screenFor } from './screenBadge.ts';

describe('screen badge: which task / Issue a screen belongs to', () => {
  it('maps every reviewed screen to its task and Issue', () => {
    const cases: [string, string, number | null][] = [
      ['#conditions', 'U03', 31], ['#/trips/t1/map', 'U04', 32], ['#/mock/trips/t1/map?day=1', 'U04', 32], ['#generate', 'U05', 33],
      ['#/trips/t1/edit', 'U06', 34], ['#/trips/t1/travel', 'U06', 34], ['#/trips/t1/guide', 'U07', 35], ['#social', 'U08', 36],
      ['#/trips/t1/print', 'E01', 37], ['', 'ホーム', null], ['#home', 'ホーム', null], ['#u01', 'U01', null],
    ];
    for (const [hash, code, issue] of cases) expect([hash, screenFor(hash).code, screenFor(hash).issue]).toEqual([hash, code, issue]);
    expect(screenFor('#abc', '/invite').issue).toBe(36);
  });
});

describe('home review list', () => {
  it('links every reviewed screen and its Issue, and each link maps back to the same task', async () => {
    const { REVIEW_LINKS } = await import('./reviewLinks.ts');
    expect(new Set(REVIEW_LINKS.map(l => l.code))).toEqual(new Set(['U03', 'U04', 'U05', 'U06', 'U07', 'U08']));
    for (const l of REVIEW_LINKS) {
      const s = screenFor(l.href);
      expect([l.href, s.code, `https://github.com/jphacks/tkb_2627/issues/${s.issue}`]).toEqual([l.href, l.code, l.issueUrl]);
    }
  });
});
