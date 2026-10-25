import type { ReactElement } from 'react';
import { renderToString as renderRaw } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Capabilities, TripSummary } from '@tkb/contracts';
import { App } from '../../App.tsx';
import { createHubApi } from './api.ts';
import { HomeLink } from './HomeLink.tsx';
import { HomeView, StatusView, TripsView, dataModeLabel } from './HomeApp.tsx';
import { parseHubHash, tripLinks } from './route.ts';

const render = (el: ReactElement) => renderRaw(el).replace(/<!-- -->/g, '');
const noop = () => {};

const trip = (id: string): TripSummary => ({
  tripId: id, title: `旅${id}`, revision: 3, validationState: 'needs_review', updatedAt: '2026-10-01T00:00:00.000Z',
  area: '京都', startDate: '2026-11-01', endDate: '2026-11-03',
} as TripSummary);

const caps = (over: Partial<Capabilities> = {}): Capabilities => ({
  entry: 'shared', aiGeneration: { available: false, runner: 'none', reason: 'SHARED_ENTRY_NO_PERSONAL_CLAUDE' },
  storage: 'shared-server', dataMode: 'fixture', schemaVersion: '1.0.0', ...over,
} as Capabilities);

const ready = (items: TripSummary[], nextCursor: string | null) =>
  ({ status: 'ready', items, nextCursor, loadingMore: false, moreError: false }) as const;

describe('hub route', () => {
  it('empty hash and #home are home, #u01 is U01, others are not hub routes', () => {
    expect(parseHubHash('')).toBe('home');
    expect(parseHubHash('#home')).toBe('home');
    expect(parseHubHash('#u01')).toBe('u01');
    expect(parseHubHash('#social')).toBeNull();
  });
  it('App renders the hub by default (no location in node)', () => {
    const html = render(<App />);
    expect(html).toContain('旅行を計画する');
    expect(html).toContain('href="#generate"');
    expect(html).toContain('href="#social"');
  });
});

describe('trip list', () => {
  it('links every trip to its screens with correct hashes', () => {
    const html = render(<TripsView state={ready([trip('t_1'), trip('t_2')], 'c')} onMore={noop} onRetry={noop} />);
    for (const id of ['t_1', 't_2']) {
      for (const s of ['map', 'edit', 'guide']) expect(html).toContain(`href="#/trips/${id}/${s}"`);
      expect(html).not.toContain('/travel"');
    }
    expect(html).toContain('もっと見る');
    expect(html).toContain('旅t_1');
    expect(tripLinks('a b')[0]?.href).toBe('#/trips/a%20b/map');
  });
  it('no more button without cursor; empty state', () => {
    expect(render(<TripsView state={ready([trip('t_1')], null)} onMore={noop} onRetry={noop} />)).not.toContain('もっと見る');
    expect(render(<TripsView state={ready([], null)} onMore={noop} onRetry={noop} />)).toContain('まだ旅程がありません');
  });
  it('401 shows the login prompt with a link', () => {
    const html = render(<TripsView state={{ status: 'unauthorized' }} onMore={noop} onRetry={noop} />);
    expect(html).toContain('ログインしてください');
    expect(html).toContain('href="#social"');
  });
  it('listTrips maps 401 and rejects bodies that break the contract', async () => {
    const mk = (status: number, body: unknown) => createHubApi(async () => new Response(JSON.stringify(body), { status }));
    expect(await mk(401, {}).listTrips()).toMatchObject({ ok: false, kind: 'unauthorized' });
    expect(await mk(200, { items: [{ nope: 1 }], nextCursor: null }).listTrips()).toMatchObject({ ok: false, kind: 'schema' });
    expect(await mk(200, { items: [], nextCursor: null }).listTrips()).toMatchObject({ ok: true });
    expect(await createHubApi(async () => { throw new Error('x'); }).listTrips('c1')).toMatchObject({ ok: false, kind: 'network' });
  });
});

describe('status', () => {
  const view = (c: Capabilities | null, err = false) => render(<StatusView caps={c} capsError={err} user={null} userState="out" />);
  it('fixture mode never says live', () => {
    const html = view(caps());
    expect(html).toContain('fixtureデータ');
    expect(html).not.toMatch(/実データ|live/);
    expect(html).toContain('利用不可');
    expect(html).toContain('href="#social"');
  });
  it('loading and error do not claim a mode', () => {
    expect(view(null)).not.toMatch(/fixture|実データ/);
    expect(view(null, true)).toContain('取得できません');
  });
  it('live label only for live', () => {
    expect(dataModeLabel('live')).toBe('実データ');
    expect(dataModeLabel('mixed')).not.toBe('実データ');
  });
  it('unknown values are shown as 不明, not 0', () => {
    const html = view(caps({ aiGeneration: { available: false, runner: 'none', reason: null } }));
    expect(html).toContain('不明');
    expect(html).not.toContain('（0）');
    const home = render(<HomeView caps={null} capsError={false} user={null} userState="loading" trips={{ status: 'loading' }} onMore={noop} onRetry={noop} />);
    expect(home).not.toContain('リビジョン 0');
  });
});

describe('HomeLink', () => {
  it('links to #home', () => {
    expect(render(<HomeLink />)).toContain('href="#home"');
  });
});
