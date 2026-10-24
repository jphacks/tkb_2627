/**
 * U01 independent tests: shared components rendered with tricky data (renderToString, node env).
 * R11: an unknown amount is shown as 不明, never as 0, and different currencies are never added together.
 */
import type { ReactElement } from 'react';
import { renderToString as renderRaw } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { JobStage, JobState, ValidationState, Visibility } from '@tkb/contracts';
import { MOCK_NOTICE, type MockScenario } from '../mocks/index.ts';
import { ErrorBox } from './ErrorBox.tsx';
import { MockBanner } from './MockBanner.tsx';
import { MoneyDeltaText, MoneyText, MoneyTotals } from './MoneyText.tsx';
import { ScenarioSwitcher } from './ScenarioSwitcher.tsx';
import { ScreenHeader } from './ScreenHeader.tsx';
import { SourceBadge } from './SourceBadge.tsx';
import { TabBar } from './TabBar.tsx';
import { JOB_STAGE_LABEL, JOB_STATE_LABEL, SCENARIOS, SCENARIO_LABEL, UNKNOWN_LABEL, VALIDATION_LABEL, VISIBILITY_LABEL } from './labels.ts';

const noop = () => {};
const renderToString = (el: ReactElement): string => renderRaw(el).replace(/<!-- -->/g, '');
const textOf = (html: string): string => html.replace(/<[^>]*>/g, '');
/** A zero shown as money: ¥0 / ￥0 / 0円 / €0.00 (not part of a larger number). */
const SHOWN_AS_ZERO = /[¥￥€$]\s?0(?:\.0+)?(?![\d,.]?\d)|(?<![\d,.])0円/;

describe('the zero detector used below', () => {
  it('matches a zero shown as money and nothing else', () => {
    for (const zero of ['￥0', '¥0', '€0.00', '$ 0', '0円', '合計 0円', '￥0 / €1.00']) expect(zero, zero).toMatch(SHOWN_AS_ZERO);
    for (const other of ['￥30', '￥1,000', '€10.05', '€0.05', '$0.50', '10円', '100円', '不明', '1,000円']) expect(other, other).not.toMatch(SHOWN_AS_ZERO);
  });
});

describe('MoneyText (R11)', () => {
  it('null is 不明 with the unknown class, and contains no digit and no currency symbol', () => {
    const html = renderToString(<MoneyText money={null} />);
    expect(html).toContain('u1-unknown');
    expect(textOf(html)).toBe(UNKNOWN_LABEL);
    expect(textOf(html)).not.toMatch(/[0-9¥￥€$]/);
  });

  it('a known amount of 0 is shown as 0 (a known free item), and is visibly different from unknown', () => {
    const zero = renderToString(<MoneyText money={{ amountMinor: 0, currency: 'JPY' }} />);
    const unknown = renderToString(<MoneyText money={null} />);
    expect(textOf(zero)).toMatch(/0/);
    expect(zero).not.toContain('u1-unknown');
    expect(zero).not.toBe(unknown);
  });

  it('formats minor units by currency: JPY has no decimals, EUR two, a 3-decimal currency three', () => {
    expect(textOf(renderToString(<MoneyText money={{ amountMinor: 3000, currency: 'JPY' }} />))).toMatch(/3,000$/);
    expect(textOf(renderToString(<MoneyText money={{ amountMinor: 1250, currency: 'EUR' }} />))).toMatch(/12\.50$/);
    expect(textOf(renderToString(<MoneyText money={{ amountMinor: 5, currency: 'EUR' }} />))).toMatch(/0\.05$/);
    expect(textOf(renderToString(<MoneyText money={{ amountMinor: 1234, currency: 'BHD' }} />))).toMatch(/1\.234$/);
  });

  it('large amounts keep every digit (no exponent notation)', () => {
    const t = textOf(renderToString(<MoneyText money={{ amountMinor: 9007199254740991, currency: 'JPY' }} />));
    expect(t).toMatch(/9,007,199,254,740,991$/);
    expect(t).not.toMatch(/e\+/i);
  });
});

describe('MoneyTotals (R11)', () => {
  it('an empty list means nothing is known: 不明, never a zero amount', () => {
    const html = renderToString(<MoneyTotals totals={[]} />);
    expect(textOf(html)).toBe(UNKNOWN_LABEL);
    expect(html).toContain('u1-unknown');
    expect(html).not.toMatch(SHOWN_AS_ZERO);
  });

  it('shows each currency separately and never adds different currencies together', () => {
    const html = renderToString(<MoneyTotals totals={[{ amountMinor: 3000, currency: 'JPY' }, { amountMinor: 1250, currency: 'EUR' }]} />);
    const t = textOf(html);
    expect(t).toMatch(/3,000/);
    expect(t).toMatch(/12\.50/);
    expect(t).toContain(' / ');
    for (const sum of ['4,250', '4250', '42.50', '3,012']) expect(t).not.toContain(sum);
  });

  it('a single currency has no separator', () => {
    expect(textOf(renderToString(<MoneyTotals totals={[{ amountMinor: 4520, currency: 'JPY' }]} />))).not.toContain(' / ');
  });

  it('three currencies are all shown in the given order', () => {
    const t = textOf(renderToString(<MoneyTotals totals={[{ amountMinor: 100, currency: 'JPY' }, { amountMinor: 200, currency: 'EUR' }, { amountMinor: 300, currency: 'USD' }]} />));
    expect(t.indexOf('100')).toBeLessThan(t.indexOf('2.00'));
    expect(t.indexOf('2.00')).toBeLessThan(t.indexOf('3.00'));
  });
});

describe('MoneyDeltaText', () => {
  it('prefixes + only for increases; a decrease keeps its minus sign', () => {
    expect(textOf(renderToString(<MoneyDeltaText money={{ amountMinor: 500, currency: 'JPY' }} />))).toMatch(/^\+/);
    const down = textOf(renderToString(<MoneyDeltaText money={{ amountMinor: -500, currency: 'JPY' }} />));
    expect(down).toMatch(/^[-−]/);
    expect(down).not.toMatch(/^\+/);
    expect(down).toMatch(/500$/);
  });

  it('keeps currencies separate: a EUR decrease is shown in EUR minor units', () => {
    expect(textOf(renderToString(<MoneyDeltaText money={{ amountMinor: -250, currency: 'EUR' }} />))).toMatch(/2\.50$/);
  });
});

describe('MockBanner and SourceBadge', () => {
  it('the banner is a status region whose text is exactly MOCK and MOCK_NOTICE', () => {
    const html = renderToString(<MockBanner />);
    expect(html).toContain('role="status"');
    expect(textOf(html)).toBe(`MOCK${MOCK_NOTICE}`);
  });

  it('the banner makes clear nothing is really saved, generated or sent', () => {
    expect(MOCK_NOTICE).toContain('モック');
    expect(MOCK_NOTICE).toContain('実際の保存・生成・通信は行っていません');
  });

  it('SourceBadge shows source mock and the HTTP status the real API would use, for success and failure', () => {
    expect(textOf(renderToString(<SourceBadge result={{ source: 'mock', status: 200 }} />))).toBe('出典: mock（HTTP 200）');
    expect(textOf(renderToString(<SourceBadge result={{ source: 'mock', status: 202 }} />))).toBe('出典: mock（HTTP 202）');
    expect(textOf(renderToString(<SourceBadge result={{ source: 'mock', status: 503 }} />))).toBe('出典: mock（HTTP 503）');
  });
});

describe('TabBar', () => {
  it.each([['trips', '旅程'], ['new', '新規作成'], ['feed', 'フィード']] as const)('marks only the %s tab as current', (active, label) => {
    const html = renderToString(<TabBar active={active} onSelect={noop} />);
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    const current = /<button[^>]*aria-current="page"[^>]*>(.*?)<\/button>/.exec(html);
    expect(textOf(current?.[1] ?? '')).toContain(label);
  });

  it('every tab is a real type=button button inside a labelled nav, and icons are hidden from screen readers', () => {
    const html = renderToString(<TabBar active="trips" onSelect={noop} />);
    expect(html).toMatch(/<nav[^>]*aria-label="メインメニュー"/);
    expect(html.match(/<button[^>]*type="button"/g)).toHaveLength(3);
    expect(html.match(/aria-hidden="true"/g)).toHaveLength(3);
  });
});

describe('ScenarioSwitcher', () => {
  it.each(SCENARIOS)('preselects %s and offers every scenario with a Japanese label', scenario => {
    const html = renderToString(<ScenarioSwitcher value={scenario} onChange={noop} />);
    expect(html.match(/<option/g)).toHaveLength(SCENARIOS.length);
    expect(html.match(/selected=""/g)).toHaveLength(1);
    expect(html).toMatch(new RegExp(`<option[^>]*value="${scenario}"[^>]*selected=""|<option[^>]*selected=""[^>]*value="${scenario}"`));
    expect(html).toContain('<label for="u1-scenario-select">');
  });

  it('has a label for every scenario the mock supports', () => {
    const all: MockScenario[] = ['normal', 'empty', 'error', 'slow', 'budgetUnknown'];
    expect([...SCENARIOS].sort()).toEqual([...all].sort());
    for (const s of all) expect(SCENARIO_LABEL[s]).toBeTruthy();
  });
});

describe('ErrorBox', () => {
  const base = { message: '接続できません', code: 'UNAVAILABLE', retryable: true, requestId: 'req_1' };

  it('is an alert with the message, code, retryability and request id', () => {
    const html = renderToString(<ErrorBox error={base} />);
    expect(html).toContain('role="alert"');
    for (const s of ['接続できません', 'UNAVAILABLE', '再試行可', 'req_1']) expect(html).toContain(s);
  });

  it('offers retry only when a handler is given, with a custom label', () => {
    expect(renderToString(<ErrorBox error={base} />)).not.toContain('<button');
    expect(renderToString(<ErrorBox error={base} onRetry={noop} />)).toContain('再試行</button>');
    expect(renderToString(<ErrorBox error={base} onRetry={noop} retryLabel="状態確認を再開" />)).toContain('状態確認を再開</button>');
  });

  it('says retry is not possible for a non-retryable error', () => {
    expect(renderToString(<ErrorBox error={{ ...base, retryable: false }} />)).toContain('再試行不可');
  });

  it('works with only a message (no code, no request id) and prints no "undefined"', () => {
    const html = renderToString(<ErrorBox error={{ message: '原因は不明です。' }} />);
    expect(html).toContain('原因は不明です。');
    expect(html).not.toContain('undefined');
    expect(html).not.toContain('コード');
    expect(html).not.toContain('リクエストID');
  });

  it('escapes markup in the message and the request id (no HTML injection from an error body)', () => {
    const html = renderToString(<ErrorBox error={{ message: '<img src=x onerror=alert(1)>', code: '<b>', requestId: '"><script>' }} />);
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;img');
  });
});

describe('ScreenHeader', () => {
  it('shows 戻る only when a handler is given, and the title is the page heading', () => {
    const root = renderToString(<ScreenHeader title="旅程" />);
    expect(root).not.toContain('戻る');
    expect(root).toMatch(/<h1[^>]*>旅程<\/h1>/);
    const deep = renderToString(<ScreenHeader title="共有" onBack={noop} />);
    expect(deep).toContain('戻る');
    expect(deep).toContain('aria-label="前の画面に戻る"');
  });
});

describe('labels cover every contract value (no "undefined" on screen)', () => {
  it.each([
    ['ValidationState', ValidationState.options, VALIDATION_LABEL],
    ['JobState', JobState.options, JOB_STATE_LABEL],
    ['JobStage', JobStage.options, JOB_STAGE_LABEL],
    ['Visibility', Visibility.options, VISIBILITY_LABEL],
  ] as const)('%s', (_name, options, labels) => {
    const record = labels as Record<string, string>;
    expect(Object.keys(record).sort()).toEqual([...options].sort());
    for (const o of options) expect(record[o]).toBeTruthy();
  });

  it('the unknown label is 不明 and not a number', () => {
    expect(UNKNOWN_LABEL).toBe('不明');
    expect(Number.isNaN(Number(UNKNOWN_LABEL))).toBe(true);
  });
});
