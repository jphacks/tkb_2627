/**
 * U01 independent tests: screen components rendered with tricky data (renderToString, node env).
 * Focus: R01 missing conditions are explicit, R08 itinerary items map to named places, R11 unknown cost is
 * never shown as 0, adoption is blocked for states the main API would refuse, and nothing private leaks
 * into the share preview.
 */
import type { ReactElement } from 'react';
import { renderToString as renderRaw } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ApiError, Money, PlanBatch, PlanCandidate, Trip, ValidationState } from '@tkb/contracts';
import {
  createBudgetUnknownOverseasTrip,
  createBudgetUnknownPlanBatch,
  createBudgetUnknownTrip,
  createEmptyItemsTrip,
  createNoDaysTrip,
  createSamplePlanBatch,
  domesticTrip,
  fixtureTrips,
} from '@tkb/fixtures';
import { TripViewer } from '../shell/TripViewer.tsx';
import { CandidateCard, CompareView } from './CandidateCompare.tsx';
import { ConditionFormView } from './ConditionInput.tsx';
import { emptyForm, sampleForm, type ConditionForm } from './condition.ts';
import { ProgressView, type ProgressViewProps } from './GenerationProgress.tsx';
import { GuideView } from './Guide.tsx';
import { FeedView, ShareView, SharePreview } from './Share.tsx';
import { DiffView, EditPanel } from './TripDetailEdit.tsx';
import { U01App } from './U01App.tsx';
import { GENERATE_MOCK_WARNING, MOCK_NOTICE } from '../mocks/index.ts';

const noop = () => {};
const renderToString = (el: ReactElement): string => renderRaw(el).replace(/<!-- -->/g, '');
const textOf = (html: string): string => html.replace(/<[^>]*>/g, '');
const buttons = (html: string): string[] => html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) ?? [];
const isDisabled = (button: string): boolean => /<button\b[^>]*\sdisabled=""/.test(button);
const buttonWith = (html: string, text: string): string => {
  const found = buttons(html).find(b => textOf(b).includes(text));
  if (!found) throw new Error(`no button with text ${text}`);
  return found;
};
const SHOWN_AS_ZERO = /[¥￥€$]\s?0(?:\.0+)?(?![\d,.]?\d)|(?<![\d,.])0円/;
/** Sentences that say a value is NOT zero. */
const withoutDisclaimers = (html: string): string => html.replace(/0円(として扱っ|として扱わ|ではありません|としては)/g, '');

const done = <T,>(data: T) => ({ status: 'done' as const, result: { ok: true as const, data, source: 'mock' as const, status: 200 } });
const batchOf = (candidates: PlanCandidate[]): PlanBatch => ({ ...createSamplePlanBatch(), candidates });
const firstCandidate = (batch = createSamplePlanBatch()): PlanCandidate => {
  const c = batch.candidates[0];
  if (!c) throw new Error('candidate');
  return c;
};

describe('candidates: adoption is offered only where the main API would accept it', () => {
  const states: ValidationState[] = ['valid', 'needs_review', 'needs_revalidation', 'invalid'];

  it.each(states)('state %s: the adopt button is disabled exactly for invalid and needs_revalidation', state => {
    const html = renderToString(<CandidateCard candidate={{ ...firstCandidate(), validationState: state }} index={0} busy={false} onAdopt={noop} />);
    const [button] = buttons(html);
    if (!button) throw new Error('button');
    const blocked = state === 'invalid' || state === 'needs_revalidation';
    expect(isDisabled(button)).toBe(blocked);
    expect(textOf(button)).toBe(blocked ? '採用できません' : 'この候補を採用');
    // the reason is written next to the button for blocked states and absent otherwise
    expect(html.includes('の候補は採用できません。')).toBe(blocked);
  });

  it('busy disables the button and says so, for an adoptable candidate', () => {
    const html = renderToString(<CandidateCard candidate={{ ...firstCandidate(), validationState: 'valid' }} index={0} busy onAdopt={noop} />);
    const [button] = buttons(html);
    expect(isDisabled(button ?? '')).toBe(true);
    expect(textOf(button ?? '')).toBe('処理中…');
  });

  it('while one adoption is in flight every candidate button is disabled (no double adoption)', () => {
    const html = renderToString(<CompareView state={done(createSamplePlanBatch())} busyId="candidate_1" applyError={null} onAdopt={noop} onRetry={noop} />);
    const adopt = buttons(html).filter(b => /処理中|この候補を採用|採用できません/.test(textOf(b)));
    expect(adopt).toHaveLength(3);
    expect(adopt.every(isDisabled)).toBe(true);
  });

  it('the validation label is always shown in Japanese for each candidate', () => {
    for (const [state, label] of [['valid', '検証済み'], ['needs_review', '要確認'], ['needs_revalidation', '再検証が必要'], ['invalid', '無効']] as const) {
      expect(renderToString(<CandidateCard candidate={{ ...firstCandidate(), validationState: state }} index={0} busy={false} onAdopt={noop} />)).toContain(label);
    }
  });
});

describe('candidates: cost display (R11)', () => {
  it('multi-currency known totals are listed per currency and never added', () => {
    const totals: Money[] = [{ amountMinor: 3000, currency: 'JPY' }, { amountMinor: 1250, currency: 'EUR' }];
    const html = renderToString(<CandidateCard candidate={{ ...firstCandidate(), totalKnownCost: totals, hasUnknownCost: false }} index={0} busy={false} onAdopt={noop} />);
    const t = textOf(html);
    expect(t).toMatch(/3,000/);
    expect(t).toMatch(/12\.50/);
    expect(t).not.toContain('4,250');
    expect(t).not.toContain('費用が未取得の項目を含みます');
  });

  it('known total plus unknown items: the unknown part is stated, not folded into the number', () => {
    const html = renderToString(<CandidateCard candidate={{ ...firstCandidate(), totalKnownCost: [{ amountMinor: 4520, currency: 'JPY' }], hasUnknownCost: true }} index={0} busy={false} onAdopt={noop} />);
    expect(textOf(html)).toContain('費用が未取得の項目を含みます');
    expect(html).toContain('上の金額には含まれておらず');
  });

  it('every candidate of the budgetUnknown batch shows 未取得 for the known cost and no zero amount', () => {
    const html = renderToString(<CompareView state={done(createBudgetUnknownPlanBatch())} busyId={null} applyError={null} onAdopt={noop} onRetry={noop} />);
    expect(withoutDisclaimers(html)).not.toMatch(SHOWN_AS_ZERO);
    expect((html.match(/u1-unknown/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });
});

describe('candidates: states of the compare screen', () => {
  it('loading, error with retry, and an apply error are distinct and visible', () => {
    expect(renderToString(<CompareView state={{ status: 'loading' }} busyId={null} applyError={null} onAdopt={noop} onRetry={noop} />)).toContain('候補を読み込み中');
    const error: ApiError = { code: 'NOT_FOUND', message: '見つかりません。', retryable: false, requestId: 'req_nf' };
    const failed = renderToString(<CompareView state={{ status: 'done', result: { ok: false, error, source: 'mock', status: 404 } }} busyId={null} applyError={null} onAdopt={noop} onRetry={noop} />);
    expect(failed).toContain('候補を読み込めませんでした');
    expect(failed).toContain('req_nf');
    expect(failed).toContain('再試行');
    expect(failed).not.toContain('この候補を採用');
    const withApplyError = renderToString(
      <CompareView state={done(createSamplePlanBatch())} busyId={null} applyError={{ code: 'REVISION_CONFLICT', message: '競合', retryable: false, requestId: 'req_ac' }} onAdopt={noop} onRetry={noop} />,
    );
    expect(withApplyError).toContain('採用できませんでした');
    expect(withApplyError).toContain('req_ac');
  });

  it('an empty candidate list says so and offers nothing to adopt (the contract needs 1..3, the view must still not crash)', () => {
    const html = renderToString(<CompareView state={done(batchOf([]))} busyId={null} applyError={null} onAdopt={noop} onRetry={noop} />);
    expect(html).toContain('候補がありません');
    expect(html).not.toContain('この候補を採用');
  });

  it('escapes markup in candidate titles, warnings and reasons', () => {
    const evil = '<img src=x onerror=alert(1)>';
    const html = renderToString(<CandidateCard candidate={{ ...firstCandidate(), title: evil, warnings: [evil], reasons: [evil] }} index={0} busy={false} onAdopt={noop} />);
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });

  it('the mock warning is visible on each generated candidate and the state is not hidden behind it', () => {
    const batch = createSamplePlanBatch();
    const withWarning = batch.candidates.map(c => ({ ...c, warnings: [...c.warnings, GENERATE_MOCK_WARNING] }));
    const html = renderToString(<CompareView state={done(batchOf(withWarning))} busyId={null} applyError={null} onAdopt={noop} onRetry={noop} />);
    expect(html.split(GENERATE_MOCK_WARNING).length - 1).toBe(3);
    expect(html).toContain('出典: mock');
  });
});

describe('R08: itinerary items map to named places in the edit panel', () => {
  const panel = (trip: Trip, props: Partial<{ saving: boolean; titleDraft: string }> = {}) =>
    renderToString(<EditPanel trip={trip} saving={props.saving ?? false} titleDraft={props.titleDraft ?? trip.title} onTitleDraft={noop} onPatch={noop} />);

  it.each(fixtureTrips.map(t => [t.tripId, t] as const))('%s: every leg shows the names of both places, none is 未取得', (_id, trip) => {
    const html = panel(trip);
    for (const leg of trip.days.flatMap(d => d.items).filter(i => i.type === 'leg')) {
      if (leg.type !== 'leg') continue;
      const from = trip.places.find(p => p.placeId === leg.fromPlaceId)?.name;
      const to = trip.places.find(p => p.placeId === leg.toPlaceId)?.name;
      expect(from, `from of ${leg.legId}`).toBeTruthy();
      expect(to, `to of ${leg.legId}`).toBeTruthy();
      expect(html).toContain(`移動: ${from} → ${to}`.replace(/'/g, '&#x27;'));
    }
    expect(html).not.toContain('undefined');
  });

  it('a leg that points to a place missing from the trip shows 未取得 instead of an id, "undefined" or a crash', () => {
    const trip: Trip = { ...domesticTrip, places: [] };
    const html = panel(trip);
    expect(html).toContain('移動: 未取得 → 未取得');
    expect(html).not.toContain('undefined');
    expect(html).not.toContain('fx_kenrokuen');
  });

  it('the first item cannot move up and the last cannot move down; every item can be deleted', () => {
    const html = panel(domesticTrip);
    const ups = buttons(html).filter(b => b.includes('を上へ移動'));
    const downs = buttons(html).filter(b => b.includes('を下へ移動'));
    const dels = buttons(html).filter(b => b.includes('を削除'));
    const total = domesticTrip.days.reduce((n, d) => n + d.items.length, 0);
    expect(ups).toHaveLength(total);
    expect(downs).toHaveLength(total);
    expect(dels).toHaveLength(total);
    // exactly one disabled "up" per non-empty day and one disabled "down" per non-empty day
    const nonEmptyDays = domesticTrip.days.filter(d => d.items.length > 0).length;
    expect(ups.filter(isDisabled)).toHaveLength(nonEmptyDays);
    expect(downs.filter(isDisabled)).toHaveLength(nonEmptyDays);
    expect(dels.filter(isDisabled)).toHaveLength(0);
  });

  it('while saving every edit button and the title button is disabled (no overlapping writes)', () => {
    const html = panel(domesticTrip, { saving: true, titleDraft: `${domesticTrip.title} 2` });
    const edit = buttons(html).filter(b => /上へ|下へ|削除|タイトルを変更/.test(b));
    expect(edit.length).toBeGreaterThan(4);
    expect(edit.every(isDisabled)).toBe(true);
  });

  it('after a revision conflict (locked) every edit button is disabled and the reason is explained; unlocked is unaffected', () => {
    const locked = renderToString(<EditPanel trip={domesticTrip} saving={false} locked titleDraft="新しい名前" onTitleDraft={noop} onPatch={noop} />);
    const edit = buttons(locked).filter(b => /上へ|下へ|削除|タイトルを変更/.test(b));
    expect(edit.length).toBeGreaterThan(4);
    expect(edit.every(isDisabled)).toBe(true);
    expect(locked).toContain('編集を止めています');
    expect(locked).toContain('再読込');
    const open = panel(domesticTrip, { titleDraft: '新しい名前' });
    expect(open).not.toContain('編集を止めています');
    expect(isDisabled(buttonWith(open, 'タイトルを変更'))).toBe(false);
  });

  it('the title button is enabled only for a real change: not for the same title, blank, or spaces', () => {
    const t = domesticTrip;
    expect(isDisabled(buttonWith(panel(t, { titleDraft: t.title }), 'タイトルを変更'))).toBe(true);
    expect(isDisabled(buttonWith(panel(t, { titleDraft: `  ${t.title}  ` }), 'タイトルを変更'))).toBe(true);
    expect(isDisabled(buttonWith(panel(t, { titleDraft: '' }), 'タイトルを変更'))).toBe(true);
    expect(isDisabled(buttonWith(panel(t, { titleDraft: '   ' }), 'タイトルを変更'))).toBe(true);
    expect(isDisabled(buttonWith(panel(t, { titleDraft: '新しい名前' }), 'タイトルを変更'))).toBe(false);
  });

  it('shows the revision being edited, and handles trips with no items or no days', () => {
    expect(panel(domesticTrip)).toContain(`編集（版 ${domesticTrip.revision}）`);
    const empty = panel(createEmptyItemsTrip());
    expect(empty).toContain('1日目');
    expect(buttons(empty).filter(b => b.includes('を削除'))).toHaveLength(0);
    const noDays = panel(createNoDaysTrip());
    expect(noDays).toContain('編集');
    expect(noDays).not.toContain('日目');
  });

  it('escapes markup in item titles and keeps it out of aria-labels', () => {
    const evil = '<script>alert(1)</script>';
    const days = domesticTrip.days.map(d => ({ ...d, items: d.items.map(i => (i.type === 'activity' ? { ...i, title: evil } : i)) }));
    const html = panel({ ...domesticTrip, days });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('diff view (R11)', () => {
  const trip = domesticTrip;
  const ids = trip.days.flatMap(d => d.items).map(i => (i.type === 'activity' ? i.activityId : i.legId));

  it('duration delta: 0 is "変化なし", positive has +, negative has -, null is 未取得', () => {
    /** Only the duration part of the diff (the cost part legitimately says 変化なし too). */
    const d = (durationDeltaSeconds: number | null) => {
      const t = textOf(renderToString(<DiffView trip={trip} diff={{ durationDeltaSeconds, knownCostDelta: [], unknownCostItems: [] }} />));
      return t.slice(t.indexOf('所要時間の変化'), t.indexOf('既知の費用の増減'));
    };
    expect(d(0)).toContain('変化なし');
    expect(d(900)).toContain('+15分');
    expect(d(-3600)).toContain('-1時間0分');
    expect(d(-5400)).toContain('-1時間30分');
    expect(d(null)).toContain('未取得（所要時間が未取得の予定を含むため算出できません）');
    expect(d(null)).not.toContain('変化なし');
  });

  it('shows one line per currency in the known delta, with signs, and no zero line', () => {
    const delta: Money[] = [{ currency: 'EUR', amountMinor: -250 }, { currency: 'JPY', amountMinor: 320 }];
    const html = renderToString(<DiffView trip={trip} diff={{ durationDeltaSeconds: 0, knownCostDelta: delta, unknownCostItems: [] }} />);
    expect(html.match(/<li>/g)).toHaveLength(2);
    expect(textOf(html)).toMatch(/\+.*320/);
    expect(textOf(html)).toMatch(/2\.50/);
    expect(html).not.toContain('変化なし（金額が分かっている項目のみ）');
  });

  it('an empty known delta with unknown items says only known amounts were compared, and lists every unknown item by its name', () => {
    const unknown = ids.filter(id => id.includes('museum') || id.includes('leg_3'));
    expect(unknown.length).toBe(2);
    const html = renderToString(<DiffView trip={trip} diff={{ durationDeltaSeconds: null, knownCostDelta: [], unknownCostItems: unknown }} />);
    expect(html).toContain('変化なし（金額が分かっている項目のみ）');
    expect(html).toContain('2件（0円として扱っていません）');
    expect(html).toContain('金沢21世紀美術館');
    expect(html).toContain('移動: 金沢21世紀美術館 → （fixture）寿司店A');
    expect(withoutDisclaimers(html)).not.toMatch(SHOWN_AS_ZERO);
  });

  it('a removed unknown-cost item is named by its title from the pre-patch trip, marked as deleted', () => {
    const removed = domesticTrip.days.flatMap(d => d.items).find(i => i.type === 'activity' && i.activityId === 'fx_act_museum');
    if (!removed || removed.type !== 'activity') throw new Error('fixture');
    const after: Trip = { ...domesticTrip, days: domesticTrip.days.map(d => ({ ...d, items: d.items.filter(i => i !== removed && !(i.type === 'activity' && i.activityId === 'fx_act_museum')) })) };
    const html = renderToString(<DiffView trip={after} before={domesticTrip} diff={{ durationDeltaSeconds: null, knownCostDelta: [], unknownCostItems: ['fx_act_museum', 'fx_act_omicho'] }} />);
    expect(html).toContain(`${removed.title}（削除済み）`);
    expect(html).not.toContain('fx_act_museum');
    // an item that still exists is named normally, without the deleted mark
    expect(html).toContain('近江町市場で食べ歩き</li>');
  });

  it('a removed leg is named with both place names from the pre-patch trip', () => {
    const after: Trip = { ...domesticTrip, days: domesticTrip.days.map(d => ({ ...d, items: d.items.filter(i => !(i.type === 'leg' && i.legId === 'fx_leg_3')) })) };
    const html = renderToString(<DiffView trip={after} before={domesticTrip} diff={{ durationDeltaSeconds: null, knownCostDelta: [], unknownCostItems: ['fx_leg_3'] }} />);
    expect(html).toContain('移動: 金沢21世紀美術館 → （fixture）寿司店A（削除済み）');
  });

  it('without the pre-patch trip, or for an id that was never in it, the id is shown with the deleted mark', () => {
    const noBefore = renderToString(<DiffView trip={domesticTrip} diff={{ durationDeltaSeconds: null, knownCostDelta: [], unknownCostItems: ['fx_gone'] }} />);
    expect(noBefore).toContain('fx_gone（削除済み）');
    const neverThere = renderToString(<DiffView trip={domesticTrip} before={domesticTrip} diff={{ durationDeltaSeconds: null, knownCostDelta: [], unknownCostItems: ['fx_gone'] }} />);
    expect(neverThere).toContain('fx_gone（削除済み）');
  });

  it('an unknown-cost id that is no longer in the trip is still listed, marked as deleted', () => {
    const html = renderToString(<DiffView trip={trip} diff={{ durationDeltaSeconds: null, knownCostDelta: [], unknownCostItems: ['fx_gone'] }} />);
    expect(html).toContain('fx_gone（削除済み）');
  });

  it('no unknown items is stated plainly', () => {
    expect(textOf(renderToString(<DiffView trip={trip} diff={{ durationDeltaSeconds: 0, knownCostDelta: [], unknownCostItems: [] }} />))).toContain('なし');
  });
});

describe('budgetUnknown trips on detail-adjacent screens: unknown stays unknown', () => {
  const unknownTrips = [createBudgetUnknownTrip(), createBudgetUnknownOverseasTrip()];

  it.each(unknownTrips.map(t => [t.tripId, t] as const))('%s: share preview, guide and viewer never show a cost as zero', (_id, trip) => {
    const share = renderToString(<SharePreview trip={trip} visibility="public" />);
    expect(withoutDisclaimers(share)).not.toMatch(SHOWN_AS_ZERO);
    const acts = trip.days.flatMap(d => d.items).filter(i => i.type === 'activity').length;
    expect((share.match(/u1-unknown/g) ?? []).length).toBe(acts);

    const day = trip.days[0]?.date ?? '2026-11-01';
    const guide = renderToString(<GuideView trip={trip} now={new Date(`${day}T03:00:00Z`)} />);
    expect(withoutDisclaimers(guide)).not.toMatch(SHOWN_AS_ZERO);
    expect(guide).toContain('費用 <span class="u1-unknown">未取得</span>');

    const viewer = renderToString(<TripViewer trips={[trip]} />);
    expect(withoutDisclaimers(viewer)).not.toMatch(SHOWN_AS_ZERO);
  });

  it('the trip viewer and the U01 screens use the same word for a value that was not obtained (未取得), and it is not a number', () => {
    const viewer = textOf(renderToString(<TripViewer trips={[createBudgetUnknownTrip()]} />));
    expect(viewer).toContain('費用 未取得');
    expect(viewer).not.toContain('費用 不明');
  });
});

describe('guide view states', () => {
  const trip = domesticTrip;

  it('upcoming, past and none are each explained, and a missing day shows no day heading', () => {
    expect(textOf(renderToString(<GuideView trip={trip} now={new Date('2026-10-01T00:00:00Z')} />))).toContain('次に来る日を表示しています');
    expect(textOf(renderToString(<GuideView trip={trip} now={new Date('2027-06-01T00:00:00Z')} />))).toContain('日程は終了しています');
    const none = textOf(renderToString(<GuideView trip={createNoDaysTrip()} now={new Date('2026-11-01T00:00:00Z')} />));
    expect(none).toContain('この旅程には日程がありません');
    expect(none).toContain('この日に残っている予定はありません');
    expect(none).not.toContain('undefined');
  });

  it('an empty day is explained as nothing left, and the location stays "not connected" in every state', () => {
    const html = renderToString(<GuideView trip={createEmptyItemsTrip()} now={new Date('2026-11-01T01:00:00Z')} />);
    expect(html).toContain('この日に残っている予定はありません');
    expect(html).toContain('現在地は未接続');
  });

  it('does not invent opening hours, and shows the data source of a place', () => {
    const noHours: Trip = { ...trip, places: trip.places.map(p => ({ ...p, openingHours: null })) };
    const html = textOf(renderToString(<GuideView trip={noHours} now={new Date('2026-11-01T01:00:00Z')} />));
    expect(html).toContain('営業時間: 未取得');
    expect(html).toMatch(/出典: fixture/);
  });

  it('a free walk shows an area and says no shop or facility is specified', () => {
    const html = textOf(renderToString(<GuideView trip={trip} now={new Date('2026-11-02T01:00:00Z')} />));
    expect(html).toContain('店・施設は未指定');
  });

  it('escapes markup in the trip title', () => {
    const html = renderToString(<GuideView trip={{ ...trip, title: '<b>x</b>' }} now={new Date('2026-11-01T01:00:00Z')} />);
    expect(html).not.toContain('<b>x</b>');
  });
});

describe('share preview never leaks private information', () => {
  const secret: Trip = {
    ...domesticTrip,
    constraints: {
      ...domesticTrip.constraints,
      budget: { amountMinor: 123456, currency: 'JPY' },
      departure: { placeId: null, label: '自宅 東京都千代田区秘密1-2-3', time: null },
      return: { placeId: null, label: '自宅 東京都千代田区秘密1-2-3', time: null },
      preferences: ['私的メモ: 母の誕生日'],
    },
  };

  it.each(['private', 'group', 'public'] as const)('scope %s: budget, home address and private preferences are absent', visibility => {
    const html = renderToString(<SharePreview trip={secret} visibility={visibility} />);
    for (const s of ['123456', '123,456', '秘密1-2-3', '千代田', '母の誕生日', '私的メモ']) expect(html, s).not.toContain(s);
    expect(html).toContain('表示されない情報: 予算、出発地・帰着地、私的なメモ');
  });

  it('the full share screen has the same property and states that nothing is posted', () => {
    const html = renderToString(<ShareView trip={secret} />);
    for (const s of ['123456', '123,456', '秘密1-2-3', '母の誕生日']) expect(html, s).not.toContain(s);
    expect(html).toContain('何も投稿・保存されません');
  });

  it('private is the default scope (nothing is public until chosen)', () => {
    const html = renderToString(<ShareView trip={domesticTrip} />);
    expect(html).toMatch(/<input[^>]*value="private"[^>]*checked=""|<input[^>]*checked=""[^>]*value="private"/);
    expect(html.match(/checked=""/g)).toHaveLength(1);
    expect(html).toContain('共有範囲: 非公開');
  });
});

describe('feed view', () => {
  it('shows every visibility label, escapes the story, and the error state offers a retry', () => {
    const post = (postId: string, visibility: 'private' | 'group' | 'public', story: string) => ({
      postId,
      title: `投稿 ${postId}`,
      authorDisplayName: 'デモ',
      area: '金沢',
      startDate: '2026-11-01',
      createdAt: '2026-10-01T00:00:00Z',
      visibility,
      story,
      tripId: null,
      snapshotId: null,
    });
    const items = [post('p1', 'public', '<script>x</script>'), post('p2', 'group', 'g'), post('p3', 'private', 'p')];
    const html = renderToString(<FeedView state={done({ items: items as never, nextCursor: null })} onRetry={noop} />);
    expect(html).not.toContain('<script>');
    for (const label of ['公開', 'グループ', '非公開']) expect(html).toContain(label);
    const error: ApiError = { code: 'UNAVAILABLE', message: '接続できません', retryable: true, requestId: 'req_f' };
    const failed = renderToString(<FeedView state={{ status: 'done', result: { ok: false, error, source: 'mock', status: 503 } }} onRetry={noop} />);
    expect(failed).toContain('フィードを読み込めませんでした');
    expect(failed).toContain('再試行');
    expect(renderToString(<FeedView state={{ status: 'loading' }} onRetry={noop} />)).toContain('フィードを読み込み中');
  });
});

describe('progress view details', () => {
  const base: ProgressViewProps = {
    state: 'running', stage: 'generating', batchId: null, jobError: null, pollError: null, note: null, cancelError: null,
    cancelling: false, polls: 3, onCancel: noop, onResume: noop, onOpenCandidates: noop, onBackToConditions: noop,
  };
  const view = (p: Partial<ProgressViewProps>) => renderToString(<ProgressView {...base} {...p} />);

  it('the cancel button exists exactly for queued and running, and is disabled while cancelling', () => {
    for (const state of ['queued', 'running'] as const) {
      expect(textOf(buttonWith(view({ state }), '取消'))).toBe('取消');
      expect(isDisabled(buttonWith(view({ state }), '取消'))).toBe(false);
    }
    const cancelling = buttonWith(view({ cancelling: true }), '取消中');
    expect(isDisabled(cancelling)).toBe(true);
    for (const state of ['succeeded', 'failed', 'cancelled'] as const) {
      expect(buttons(view({ state, batchId: 'b' })).some(b => textOf(b) === '取消' || textOf(b) === '取消中…')).toBe(false);
    }
  });

  it('a running job says that leaving does not stop it (R28) and offers only the explicit 取消', () => {
    const html = textOf(view({ state: 'running', stage: 'generating' }));
    expect(html).toContain('他の画面へ移っても生成は止まりません');
    expect(html).not.toContain('生成を取り消します');
    expect(html).toContain('取消');
  });

  it('success without a batch id does not show the compare button (no link to nothing)', () => {
    expect(view({ state: 'succeeded', stage: 'saved', batchId: null })).not.toContain('候補を比較する');
  });

  it('a failure without error details says the cause is not obtained instead of inventing one', () => {
    const html = view({ state: 'failed', stage: 'validating', jobError: null });
    expect(html).toContain('原因を取得できませんでした。');
    expect(html).not.toContain('undefined');
  });

  it('only one step is marked current while running, none once finished', () => {
    expect(view({ state: 'running', stage: 'validating' }).match(/aria-current="step"/g)).toHaveLength(1);
    for (const state of ['succeeded', 'failed', 'cancelled'] as const) expect(view({ state, stage: 'saved', batchId: 'b' })).not.toContain('aria-current="step"');
  });

  it('the late stages saving/done map to the last step, and a missing stage to the first', () => {
    for (const stage of ['saving', 'done'] as const) {
      const html = view({ state: 'running', stage });
      expect(html).toMatch(/<li[^>]*aria-current="step"[^>]*>保存済み<\/li>/);
    }
    expect(view({ state: 'queued', stage: null })).toMatch(/<li[^>]*aria-current="step"[^>]*>受付済み<\/li>/);
  });

  it('a cancel that was refused because the batch is already saved explains it, and shows a cancel error separately', () => {
    expect(view({ note: 'すでに候補が保存されているため取り消せません。' })).toContain('すでに候補が保存されている');
    const err: ApiError = { code: 'UNAVAILABLE', message: '接続できません', retryable: true, requestId: 'req_c' };
    const html = view({ cancelError: err });
    expect(html).toContain('取消できませんでした');
    expect(html).toContain('req_c');
  });
});

describe('condition form states (R01)', () => {
  const view = (form: ConditionForm, extra: Partial<{ submitted: boolean; busy: boolean }> = {}) =>
    renderToString(<ConditionFormView form={form} onChange={noop} onSubmit={noop} submitted={extra.submitted ?? true} busy={extra.busy ?? false} submitError={null} />);

  it('lists all missing required fields in the checklist before any submit, with exactly the missing ones marked', () => {
    const html = view(emptyForm, { submitted: false });
    for (const label of ['地域', '開始日', '終了日', 'タイムゾーン', '交通手段']) expect(html).toContain(`未入力：${label}`);
    expect(html.match(/未入力：/g)).toHaveLength(5);
    expect(html).not.toContain('入力済み：');
    // the zone is not pre-filled any more: only the example placeholder is shown
    expect(html).toMatch(/<input[^>]*id="c-tz"[^>]*value=""|<input[^>]*value=""[^>]*id="c-tz"/);
    expect(html).toContain('placeholder="例: Asia/Tokyo"');
    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain('aria-invalid="true"');
  });

  it('a whitespace-only area is still shown as missing', () => {
    expect(view({ ...sampleForm, area: '   ' }, { submitted: false })).toContain('未入力：地域');
  });

  it('after a submit attempt the alert names every field with a problem, with its own message', () => {
    const html = view({ ...sampleForm, endDate: '2026-10-01', timeZone: '+09:00', budgetMode: 'amount', budgetAmount: '-5', mustVisit: '' });
    expect(html).toContain('入力内容を確認してください（3件）');
    for (const label of ['終了日', 'タイムゾーン', '予算']) expect(textOf(html)).toContain(`${label}:`);
    expect((html.match(/aria-invalid="true"/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it('shows the amount and currency inputs only when an amount is chosen, and the unknown choice states it is not 0 yen', () => {
    const unknown = view(sampleForm);
    expect(unknown).not.toContain('id="c-amount"');
    expect(unknown).toContain('0円としては扱いません');
    const amount = view({ ...sampleForm, budgetMode: 'amount', budgetAmount: '3000' });
    expect(amount).toContain('id="c-amount"');
    expect(amount).toContain('id="c-cur"');
  });

  it('every text/select/textarea field has a label that points at it', () => {
    for (const f of [emptyForm, sampleForm, { ...sampleForm, budgetMode: 'amount' as const, budgetAmount: '1' }]) {
      const html = view(f);
      const ids = [...html.matchAll(/<(?:input|select|textarea)\b[^>]*\bid="([^"]+)"/g)].map(m => m[1] as string);
      expect(ids.length).toBeGreaterThanOrEqual(5);
      for (const id of ids) expect(html, id).toMatch(new RegExp(`<label[^>]*for="${id}"`));
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it('busy disables the submit button and changes its text; the form is not submitted natively (noValidate)', () => {
    const html = view(sampleForm, { busy: true });
    expect(isDisabled(buttonWith(html, '送信中'))).toBe(true);
    expect(html).toContain('noValidate');
    expect(isDisabled(buttonWith(view(sampleForm), '候補を生成する'))).toBe(false);
  });

  it('a start-date value is the minimum for the end-date input, and the chosen transport is the checked radio', () => {
    const html = view({ ...sampleForm, transportMode: 'car' });
    expect(html).toMatch(/<input[^>]*id="c-end"[^>]*min="2026-11-01"|<input[^>]*min="2026-11-01"[^>]*id="c-end"/);
    expect(html.match(/name="c-mode"[^>]*checked=""|checked=""[^>]*name="c-mode"/g)).toHaveLength(1);
    expect(html).toMatch(/<input[^>]*value="car"[^>]*checked=""|<input[^>]*checked=""[^>]*value="car"/);
  });

  it('a failed submit shows the API error with its request id', () => {
    const error: ApiError = { code: 'VALIDATION_FAILED', message: '入力が不正です。', retryable: false, requestId: 'req_v' };
    const html = renderToString(
      <ConditionFormView form={sampleForm} onChange={noop} onSubmit={noop} submitted busy={false} submitError={error} />,
    );
    expect(html).toContain('生成を開始できませんでした');
    expect(html).toContain('req_v');
  });

  it('a thrown error (message and code only, no request id) is shown in the same box without "undefined"', () => {
    const html = renderToString(
      <ConditionFormView form={sampleForm} onChange={noop} onSubmit={noop} submitted busy={false} submitError={{ message: 'network down', code: 'INTERNAL' }} />,
    );
    expect(html).toContain('生成を開始できませんでした');
    expect(html).toContain('network down');
    expect(html).not.toContain('undefined');
    expect(html).not.toContain('リクエストID');
  });

  it('aria-describedby only points at elements that exist, with and without errors', () => {
    const forms: ConditionForm[] = [
      emptyForm,
      sampleForm,
      { ...sampleForm, endDate: '2026-10-01', timeZone: '+09:00', budgetMode: 'amount', budgetAmount: '-5', mustVisit: '場'.repeat(300) },
    ];
    for (const f of forms) {
      for (const submitted of [false, true]) {
        const html = view(f, { submitted });
        for (const m of html.matchAll(/aria-describedby="([^"]+)"/g)) {
          for (const id of (m[1] as string).split(' ')) expect(html, `${id} (submitted=${String(submitted)})`).toMatch(new RegExp(`\\sid="${id}"`));
        }
      }
    }
  });

  it('the must-visit field says typed names are sent as preferences, not as confirmed must-visit places', () => {
    const t = textOf(view(sampleForm));
    expect(t).toContain('preferences');
    expect(t).toContain('必須地点（mustVisit）としては確定されません');
    expect(t).not.toContain('mustVisit として');
  });

  it('too many or too long must-visit entries show a message on the must-visit field, with the limit', () => {
    const many = Array.from({ length: 21 }, (_, i) => `場所${i}`).join('\n');
    const html = view({ ...sampleForm, mustVisit: many });
    expect(textOf(html)).toContain('必須地点: 必須地点は20件までです');
    expect(html).toMatch(/<textarea[^>]*aria-invalid="true"|<textarea[^>]*aria-describedby="c-must-note c-must-err"/);
    const long = view({ ...sampleForm, mustVisit: '場'.repeat(300) });
    expect(textOf(long)).toContain('が長すぎます');
  });

  it('escapes markup typed into text fields', () => {
    const html = view({ ...sampleForm, area: '"><script>alert(1)</script>', mustVisit: '<img src=x>' });
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
  });
});

describe('U01App: the first render in every scenario', () => {
  it.each(['normal', 'empty', 'error', 'slow', 'budgetUnknown'] as const)('%s renders the banner, switcher with the scenario selected, tabs, and no crash', scenario => {
    const html = renderToString(<U01App initialScenario={scenario} />);
    expect(html).toContain(MOCK_NOTICE);
    expect(html).toMatch(new RegExp(`<option[^>]*value="${scenario}"[^>]*selected=""|<option[^>]*selected=""[^>]*value="${scenario}"`));
    expect(html).toContain('旅程を読み込み中');
    expect(html).toContain('aria-current="page"');
    expect(html).not.toContain('undefined');
  });
});
