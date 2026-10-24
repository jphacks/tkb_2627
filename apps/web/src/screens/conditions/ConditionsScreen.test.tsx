import type { ReactElement } from 'react';
import { renderToString as renderRaw } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Capabilities } from '@tkb/contracts';
import { kanazawaPlaces } from '@tkb/fixtures';
import { ConditionsView, PlaceCard, type ConditionsViewProps } from './ConditionsScreen.tsx';
import { ConditionsApp } from './ConditionsApp.tsx';
import { addMustVisit, emptyConditions, sampleConditions, setModeForDate } from './model.ts';

const renderToString = (el: ReactElement) => renderRaw(el).replace(/<!-- -->/g, '');
const noop = () => undefined;
const caps = (available: boolean): Capabilities => ({
  entry: 'personal',
  aiGeneration: available ? { available: true, runner: 'fake', reason: null } : { available: false, runner: 'none', reason: 'CLI_NOT_AUTHENTICATED' },
  storage: 'shared-server',
  dataMode: 'fixture',
  schemaVersion: 1,
});
const base: ConditionsViewProps = {
  form: sampleConditions,
  onChange: noop,
  onSubmit: noop,
  onSearch: noop,
  searchArea: '',
  onSearchAreaChange: noop,
  search: { status: 'idle' },
  capability: { status: 'done', data: caps(true) },
  submitted: false,
  busy: false,
  submitError: null,
  accepted: null,
  source: 'mock',
  now: new Date('2026-10-25T00:00:00Z'),
};
const render = (p: Partial<ConditionsViewProps>) => renderToString(<ConditionsView {...base} {...p} />);
const kenrokuen = kanazawaPlaces.find(p => p.placeId === 'fx_kenrokuen')!;

describe('U03 screen rendering', () => {
  it('shows missing fields and, after submit, the error summary', () => {
    const html = render({ form: emptyConditions, submitted: true });
    expect(html).toContain('未入力');
    expect(html).toContain('入力内容を確認してください（5件）');
  });

  it('shows the AI-unavailable reason and disables submit while keeping the form usable', () => {
    const html = render({ capability: { status: 'done', data: caps(false) } });
    expect(html).toContain('AI生成は現在利用できません');
    expect(html).toContain('Claude Code CLI にログインしていません');
    expect(html).toMatch(/<button type="submit"[^>]*disabled/);
    expect(html).not.toMatch(/id="u3-area"[^>]*disabled/);
  });

  it('shows per-day mode selectors with local dates for multi-day trips', () => {
    const html = render({ form: setModeForDate(sampleConditions, '2026-11-02', 'car') });
    expect(html).toContain('11/1(日)');
    expect(html).toContain('11/2(月)');
    expect(html).toContain('日ごとの交通手段');
  });

  it('lists search results with source badges and the selected must-visit places', () => {
    const html = render({
      form: addMustVisit(sampleConditions, kenrokuen),
      search: { status: 'done', places: kanazawaPlaces, unknown: ['fare'], dataMode: 'fixture', source: 'mock' },
    });
    expect(html).toContain('出典: fixture / tkb_2627 fixture');
    expect(html).toContain('選択済み（1件）');
    expect(html).toContain('必須地点から外す（兼六園）');
    expect(html).toContain('必須地点に追加（近江町市場）');
    expect(html).toContain('食事（固定店舗）');
    expect(html).toContain('取得できなかった項目: fare');
  });

  it('enables the place search from the trip area and disables it without a mode', () => {
    expect(render({})).not.toMatch(/<button type="button" class="btn" disabled="">候補地点を検索/);
    const noMode = { ...sampleConditions, base: { ...sampleConditions.base, transportMode: '' as const } };
    expect(render({ form: noMode })).toMatch(/<button type="button" class="btn" disabled="">候補地点を検索/);
  });

  it('shows an empty state and a retryable search error', () => {
    expect(render({ search: { status: 'done', places: [], unknown: [], dataMode: 'fixture', source: 'mock' } })).toContain('見つかりませんでした');
    const err = render({ search: { status: 'error', error: { message: '情報源に接続できません。', code: 'PROVIDER_UNAVAILABLE', retryable: true } } });
    expect(err).toContain('地点を取得できませんでした');
    expect(err).toContain('PROVIDER_UNAVAILABLE');
  });

  it('shows submit errors and the accepted job id', () => {
    expect(render({ submitError: { message: 'ログインが必要です', code: 'UNAUTHENTICATED' } })).toContain('生成を開始できませんでした');
    expect(render({ accepted: { jobId: 'job_42', state: 'queued', pollAfterMs: 2000 } })).toContain('job_42');
  });

  it('shows the budget in its own currency', () => {
    const form = { ...sampleConditions, base: { ...sampleConditions.base, budgetMode: 'amount' as const, budgetAmount: '200', budgetCurrency: 'EUR' } };
    expect(render({ form })).toContain('EURのみ');
  });

  it('marks places in another time zone', () => {
    const html = renderToString(<PlaceCard place={{ ...kenrokuen, timeZone: 'Europe/Paris' }} selected={false} onToggle={noop} tripZone="Asia/Tokyo" />);
    expect(html).toContain('タイムゾーンが旅行（Asia/Tokyo）と異なります');
  });

  it('labels mock vs live data', () => {
    expect(render({ source: 'live' })).toContain('実API');
    expect(renderToString(<ConditionsApp />)).toContain('MOCK');
    expect(renderToString(<ConditionsApp initialSource="live" />)).toContain('LIVE');
  });
});
