/**
 * U01 independent tests: R01 condition form edge cases (blank/whitespace, dates, time zones, budget minor units,
 * mustVisit). The invariants at the end run the validator over a cross product of messy inputs.
 */
import { describe, expect, it } from 'vitest';
import { GenerateRequest } from '@tkb/contracts';
import {
  MAX_PREFERENCES,
  MAX_PREFERENCE_LENGTH,
  MUST_VISIT_PREFIX,
  REQUIRED_FIELDS,
  emptyForm,
  parseBudget,
  sampleForm,
  splitMustVisit,
  validateCondition,
  type ConditionForm,
  type FieldKey,
} from './condition.ts';

const form = (patch: Partial<ConditionForm>): ConditionForm => ({ ...sampleForm, ...patch });
const withBudget = (budgetAmount: string, budgetCurrency = 'JPY') => form({ budgetMode: 'amount', budgetAmount, budgetCurrency });

describe('R01 required fields and blanks', () => {
  it.each(['', ' ', '   ', '\t', '\n', '　'])('area %j (blank / ASCII or full-width whitespace) is missing, never sent', area => {
    const r = validateCondition(form({ area }));
    expect(r.request).toBeNull();
    expect(r.missing).toContain('area');
    expect(r.errors.area).toBeTruthy();
  });

  it('area is trimmed in the request', () => {
    expect(validateCondition(form({ area: '  金沢  ' })).request?.constraints.area).toBe('金沢');
    expect(validateCondition(form({ area: '　金沢　' })).request?.constraints.area).toBe('金沢');
  });

  it('area length boundary is 200 after trimming', () => {
    expect(validateCondition(form({ area: 'あ'.repeat(200) })).request).not.toBeNull();
    expect(validateCondition(form({ area: `  ${'あ'.repeat(200)}  ` })).request).not.toBeNull();
    const over = validateCondition(form({ area: 'あ'.repeat(201) }));
    expect(over.request).toBeNull();
    expect(over.errors.area).toBeTruthy();
    // too long is an error, but not "missing"
    expect(over.missing).not.toContain('area');
  });

  it('every required field reported missing carries an error, and the checklist only lists required fields', () => {
    const r = validateCondition(form({ area: '', startDate: '', endDate: '', timeZone: ' ', transportMode: '' }));
    expect(r.missing.sort()).toEqual([...REQUIRED_FIELDS].sort());
    for (const k of r.missing) expect(r.errors[k]).toBeTruthy();
  });

  it('the empty form has no default time zone: all 5 required fields are missing and none is silently confirmed', () => {
    expect(emptyForm.timeZone).toBe('');
    const r = validateCondition(emptyForm);
    expect(r.request).toBeNull();
    expect(r.missing).toEqual(['area', 'startDate', 'endDate', 'timeZone', 'transportMode']);
    expect(r.missing).toHaveLength(5);
    expect(Object.keys(r.errors).sort()).toEqual(['area', 'endDate', 'startDate', 'timeZone', 'transportMode']);
    // everything else filled but the zone: only the zone is missing
    expect(validateCondition({ ...sampleForm, timeZone: '' }).missing).toEqual(['timeZone']);
  });

  it('transport mode is mandatory, and an unknown mode string never produces a request', () => {
    expect(validateCondition(form({ transportMode: '' })).request).toBeNull();
    const bogus = validateCondition(form({ transportMode: 'plane' as ConditionForm['transportMode'] }));
    expect(bogus.request).toBeNull();
    expect(Object.keys(bogus.errors).length).toBeGreaterThan(0);
  });
});

describe('R01 dates', () => {
  it('end before start is an error on endDate; same day and later are fine', () => {
    const before = validateCondition(form({ startDate: '2026-11-05', endDate: '2026-11-04' }));
    expect(before.request).toBeNull();
    expect(before.errors.endDate).toBeTruthy();
    expect(before.missing).not.toContain('endDate');
    expect(validateCondition(form({ startDate: '2026-11-05', endDate: '2026-11-05' })).request).not.toBeNull();
    expect(validateCondition(form({ startDate: '2026-11-05', endDate: '2026-11-06' })).request).not.toBeNull();
  });

  it('compares across month and year boundaries correctly', () => {
    expect(validateCondition(form({ startDate: '2026-12-31', endDate: '2027-01-01' })).request).not.toBeNull();
    expect(validateCondition(form({ startDate: '2027-01-01', endDate: '2026-12-31' })).request).toBeNull();
    // leap day
    expect(validateCondition(form({ startDate: '2028-02-29', endDate: '2028-03-01' })).request).not.toBeNull();
  });

  it('end date alone missing: only that field is reported, not a date-order error', () => {
    const r = validateCondition(form({ endDate: '' }));
    expect(r.missing).toEqual(['endDate']);
    expect(r.errors.endDate).toBeTruthy();
  });

  it.each(['2026-02-30', '2026-13-01', '2026/11/01', '11-01-2026', 'tomorrow', '2026-1-5'])('a non-date value %j never produces a request', bad => {
    const asStart = validateCondition(form({ startDate: bad, endDate: '2030-01-01' }));
    expect(asStart.request).toBeNull();
    expect(Object.keys(asStart.errors).length).toBeGreaterThan(0);
    const asEnd = validateCondition(form({ endDate: bad }));
    expect(asEnd.request).toBeNull();
    expect(Object.keys(asEnd.errors).length).toBeGreaterThan(0);
  });

  // A malformed date (pasted/autofilled, or a browser without date pickers) used to be reported on `area`
  // by the final contract parse. It is now reported on the date field itself.
  it('a malformed start date is reported on startDate only (not on area, not as missing)', () => {
    const r = validateCondition(form({ startDate: '2026-02-30', endDate: '2026-03-02' }));
    expect(r.request).toBeNull();
    expect(r.errors.startDate).toBeTruthy();
    expect(Object.keys(r.errors)).toEqual(['startDate']);
    expect(r.missing).toEqual([]);
  });

  it('a malformed end date is reported on endDate only (not on area, not as missing)', () => {
    const r = validateCondition(form({ startDate: '2026-02-01', endDate: '2026-13-01' }));
    expect(r.request).toBeNull();
    expect(r.errors.endDate).toBeTruthy();
    expect(Object.keys(r.errors)).toEqual(['endDate']);
    expect(r.missing).toEqual([]);
  });

  it.each(['2026-02-30', '2026-13-01', '2026-00-10', '2026-04-31', '2027-02-29', '2026/11/01', '2026-1-5', 'tomorrow', ' 2026-11-01'])(
    'the value %j is an error on the date field it was typed into and never on area',
    bad => {
      const asStart = validateCondition(form({ startDate: bad, endDate: '2030-01-01' }));
      expect(asStart.request).toBeNull();
      expect(asStart.errors.startDate).toBeTruthy();
      expect(asStart.errors.area).toBeUndefined();
      const asEnd = validateCondition(form({ endDate: bad }));
      expect(asEnd.request).toBeNull();
      expect(asEnd.errors.endDate).toBeTruthy();
      expect(asEnd.errors.area).toBeUndefined();
    },
  );

  it('real leap days are accepted, and both dates malformed gives one error each', () => {
    expect(validateCondition(form({ startDate: '2028-02-29', endDate: '2028-02-29' })).request).not.toBeNull();
    const both = validateCondition(form({ startDate: '2026-02-30', endDate: '2026-13-01' }));
    expect(Object.keys(both.errors).sort()).toEqual(['endDate', 'startDate']);
  });

  it('with a malformed start date the order check is skipped (no misleading "end before start")', () => {
    const r = validateCondition(form({ startDate: '2026-02-30', endDate: '2026-01-01' }));
    expect(r.errors.endDate).toBeUndefined();
    expect(r.errors.startDate).toBeTruthy();
  });
});

describe('R01 time zone', () => {
  it.each(['Asia/Tokyo', 'Europe/Paris', 'America/New_York', 'Australia/Sydney', 'UTC', 'America/Argentina/Buenos_Aires'])('accepts IANA zone %s', timeZone => {
    expect(validateCondition(form({ timeZone })).request?.constraints.timeZone).toBe(timeZone);
  });

  it('trims the zone before sending it', () => {
    expect(validateCondition(form({ timeZone: '  Europe/Paris ' })).request?.constraints.timeZone).toBe('Europe/Paris');
  });

  it.each(['+09:00', 'UTC+9', 'JST', 'Tokyo', 'Asia/Nowhere', 'Asia/', '/Tokyo', 'Asia Tokyo', 'GMT+9'])('rejects non-IANA zone %j', timeZone => {
    const r = validateCondition(form({ timeZone }));
    expect(r.request).toBeNull();
    expect(r.errors.timeZone).toBeTruthy();
    expect(r.missing).not.toContain('timeZone');
  });

  it('a blank zone is "missing", not "invalid"', () => {
    const r = validateCondition(form({ timeZone: '   ' }));
    expect(r.missing).toContain('timeZone');
    expect(r.request).toBeNull();
  });
});

describe('R01 / R11 budget', () => {
  it('unknown budget sends budget: null (an explicit key), never 0, whatever is left typed in the amount field', () => {
    for (const budgetAmount of ['', '0', '30000', 'abc', '-5']) {
      const r = validateCondition(form({ budgetMode: 'unknown', budgetAmount }));
      expect(r.errors).toEqual({});
      expect(r.request?.constraints.budget).toBeNull();
      expect(Object.prototype.hasOwnProperty.call(r.request?.constraints, 'budget')).toBe(true);
      expect(JSON.stringify(r.request)).toContain('"budget":null');
    }
  });

  it('a typed amount is sent in minor units of its own currency, with no merging across currencies', () => {
    expect(validateCondition(withBudget('30000', 'JPY')).request?.constraints.budget).toEqual({ amountMinor: 30000, currency: 'JPY' });
    expect(validateCondition(withBudget('30000', 'EUR')).request?.constraints.budget).toEqual({ amountMinor: 3000000, currency: 'EUR' });
    expect(validateCondition(withBudget('199.99', 'USD')).request?.constraints.budget).toEqual({ amountMinor: 19999, currency: 'USD' });
  });

  it('JPY (0 decimals) rejects any fraction; EUR/USD (2 decimals) accept up to 2 digits and reject 3', () => {
    expect(parseBudget('1000.5', 'JPY')).toBeNull();
    expect(parseBudget('1000.0', 'JPY')).toEqual({ amountMinor: 1000, currency: 'JPY' });
    expect(parseBudget('10', 'EUR')).toEqual({ amountMinor: 1000, currency: 'EUR' });
    expect(parseBudget('10.5', 'EUR')).toEqual({ amountMinor: 1050, currency: 'EUR' });
    expect(parseBudget('10.55', 'EUR')).toEqual({ amountMinor: 1055, currency: 'EUR' });
    expect(parseBudget('10.555', 'EUR')).toBeNull();
    expect(parseBudget('1.005', 'EUR')).toBeNull();
    // 3-decimal currency and a 0-decimal one other than JPY follow the same rule.
    expect(parseBudget('1.234', 'BHD')).toEqual({ amountMinor: 1234, currency: 'BHD' });
    expect(parseBudget('1500', 'KRW')).toEqual({ amountMinor: 1500, currency: 'KRW' });
    expect(parseBudget('1500.5', 'KRW')).toBeNull();
  });

  it('every cent value round-trips exactly through the float conversion (no off-by-one-cent)', () => {
    for (let cents = 0; cents <= 20000; cents += 1) {
      const text = `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
      expect(parseBudget(text, 'EUR')?.amountMinor, text).toBe(cents);
    }
  });

  it('budget 0 is accepted only when the user explicitly chose an amount and typed 0 (an explicit 0 is not "unknown")', () => {
    const r = validateCondition(withBudget('0'));
    expect(r.request?.constraints.budget).toEqual({ amountMinor: 0, currency: 'JPY' });
    // ... and the default (unknown) is a different value from 0.
    expect(validateCondition(sampleForm).request?.constraints.budget).toBeNull();
  });

  it.each(['-1', '-0.5', '+5', '1e3', '1,000', '１２３', '12 000', '.5', '5.', '0x10', 'NaN', 'Infinity', '--1', '１０.５', ' - 1'])('rejects the non-amount %j with a budget error', text => {
    const r = validateCondition(withBudget(text));
    expect(r.request).toBeNull();
    expect(r.errors.budget).toBeTruthy();
  });

  it('blank amount while "金額を指定する" is chosen is an error (never silently 0 or unknown)', () => {
    for (const text of ['', '   ']) {
      const r = validateCondition(withBudget(text));
      expect(r.request).toBeNull();
      expect(r.errors.budget).toBeTruthy();
    }
  });

  it('surrounding whitespace and leading zeros are tolerated', () => {
    expect(validateCondition(withBudget('  5000  ')).request?.constraints.budget?.amountMinor).toBe(5000);
    expect(validateCondition(withBudget('007')).request?.constraints.budget?.amountMinor).toBe(7);
  });

  it('very large amounts: beyond the safe integer range is rejected, the maximum safe JPY amount passes the contract', () => {
    expect(parseBudget('9007199254740992', 'JPY')).toBeNull();
    expect(parseBudget('99999999999999999999999', 'JPY')).toBeNull();
    expect(parseBudget('1'.repeat(400), 'JPY')).toBeNull();
    expect(validateCondition(withBudget('9007199254740991')).request?.constraints.budget?.amountMinor).toBe(9007199254740991);
    // EUR: the cent conversion must not silently round a huge value into a different one.
    const huge = parseBudget('90071992547409.91', 'EUR');
    if (huge) expect(Number.isSafeInteger(huge.amountMinor)).toBe(true);
    expect(parseBudget('9007199254740991', 'EUR')).toBeNull();
  });

  it('an invalid or lower-case currency code never produces a request', () => {
    for (const currency of ['', 'jp', 'JPYY', 'ZZ', '12', 'jpy']) {
      const r = validateCondition(withBudget('1000', currency));
      expect(r.request, currency).toBeNull();
      expect(Object.keys(r.errors).length, currency).toBeGreaterThan(0);
    }
  });
});

describe('R01 must-visit places', () => {
  it('splits on newline, comma and the Japanese comma; trims; drops blanks and duplicates, keeping first-seen order', () => {
    expect(splitMustVisit('a,b、c\nd\r\n e ,, \n\n')).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(splitMustVisit('x\nx\ny\nx')).toEqual(['x', 'y']);
    expect(splitMustVisit('')).toEqual([]);
    expect(splitMustVisit(' \n \t ,')).toEqual([]);
  });

  const PREFIX = '必須地点（名称・地点ID未解決）: ';

  it('the prefix and limits exported by condition.ts match the stated contract values', () => {
    expect(MUST_VISIT_PREFIX).toBe(PREFIX);
    expect(MAX_PREFERENCES).toBe(20);
    expect(MAX_PREFERENCE_LENGTH).toBe(200);
  });

  it('every typed entry, whether or not it looks like a place ID, is sent as a preference; mustVisit is never sent', () => {
    const r = validateCondition(form({ mustVisit: 'fx_kenrokuen\n兼六園\nplace-2\nKyoto Station\n近江町市場' }));
    expect(r.errors).toEqual({});
    expect(r.request?.constraints.preferences).toEqual([
      `${PREFIX}fx_kenrokuen`,
      `${PREFIX}兼六園`,
      `${PREFIX}place-2`,
      `${PREFIX}Kyoto Station`,
      `${PREFIX}近江町市場`,
    ]);
    expect('mustVisit' in (r.request?.constraints ?? {})).toBe(false);
  });

  it('an ASCII name without spaces (Kenrokuen, Eiffel-Tower) is no longer taken for a place ID', () => {
    const r = validateCondition(form({ mustVisit: 'Kenrokuen\nEiffel-Tower' }));
    expect(r.request?.constraints.preferences).toEqual([`${PREFIX}Kenrokuen`, `${PREFIX}Eiffel-Tower`]);
    expect('mustVisit' in (r.request?.constraints ?? {})).toBe(false);
  });

  it('omits mustVisit and preferences completely when nothing is typed (no empty arrays, no invented fields)', () => {
    for (const text of ['', '  \n ', ' , 、 ']) {
      const c = validateCondition(form({ mustVisit: text })).request?.constraints ?? {};
      expect('mustVisit' in c, text).toBe(false);
      expect('preferences' in c, text).toBe(false);
    }
  });

  it('mustVisit is omitted for every input, including 31 ID-shaped entries (the count limit is 20 now)', () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `p${i}`).join('\n');
    const ok = validateCondition(form({ mustVisit: ids(20) }));
    expect(ok.request?.constraints.preferences).toHaveLength(20);
    expect('mustVisit' in (ok.request?.constraints ?? {})).toBe(false);
    for (const n of [21, 30, 31, 100]) {
      const over = validateCondition(form({ mustVisit: ids(n) }));
      expect(over.request, String(n)).toBeNull();
      expect(over.errors.mustVisit, String(n)).toBeTruthy();
    }
  });

  it('count boundary: 20 names pass, 21 are an error on mustVisit and no request is built', () => {
    const names = (n: number) => Array.from({ length: n }, (_, i) => `場所${i}`).join('\n');
    expect(validateCondition(form({ mustVisit: names(20) })).request?.constraints.preferences).toHaveLength(20);
    const over = validateCondition(form({ mustVisit: names(21) }));
    expect(over.request).toBeNull();
    expect(over.errors.mustVisit).toBeTruthy();
    expect(over.missing).not.toContain('mustVisit');
  });

  it('duplicates are removed before counting (21 lines with one repeat is 20 entries)', () => {
    const lines = [...Array.from({ length: 20 }, (_, i) => `場所${i}`), '場所0'].join('\n');
    expect(validateCondition(form({ mustVisit: lines })).request?.constraints.preferences).toHaveLength(20);
  });

  it('length boundary: prefix + name must fit 200 characters; one more character is an error', () => {
    const max = 200 - PREFIX.length;
    const ok = validateCondition(form({ mustVisit: '場'.repeat(max) }));
    expect(ok.request?.constraints.preferences?.[0]).toHaveLength(200);
    const over = validateCondition(form({ mustVisit: '場'.repeat(max + 1) }));
    expect(over.request).toBeNull();
    expect(over.errors.mustVisit).toBeTruthy();
    // one long entry among valid ones still blocks the whole request
    expect(validateCondition(form({ mustVisit: `兼六園\n${'場'.repeat(max + 1)}` })).request).toBeNull();
  });

  it('a very long ID-looking token is just a long name: it fits or fails by the same length rule', () => {
    const max = 200 - PREFIX.length;
    expect(validateCondition(form({ mustVisit: 'a'.repeat(max) })).request?.constraints.preferences).toEqual([`${PREFIX}${'a'.repeat(max)}`]);
    expect(validateCondition(form({ mustVisit: 'a'.repeat(129) })).request?.constraints.preferences).toHaveLength(1);
    expect(validateCondition(form({ mustVisit: 'a'.repeat(max + 1) })).request).toBeNull();
  });

  it('the error message for an over-long entry does not echo more than a short head of it', () => {
    const r = validateCondition(form({ mustVisit: '場'.repeat(500) }));
    expect((r.errors.mustVisit ?? '').length).toBeLessThan(120);
  });

  it('full-width comma is not a separator (one name), so a pasted list does not silently split', () => {
    expect(splitMustVisit('兼六園，近江町市場')).toEqual(['兼六園，近江町市場']);
  });
});

describe('invariants over a cross product of messy forms', () => {
  const areas = ['', '金沢', ' 金沢 ', 'あ'.repeat(201)];
  const dates = ['', '2026-11-01', '2026-10-31', '2026-02-30'];
  const zones = ['', 'Asia/Tokyo', '+09:00', 'Europe/Paris'];
  const modes: ConditionForm['transportMode'][] = ['', 'transit', 'car'];
  const budgets: [ConditionForm['budgetMode'], string, string][] = [
    ['unknown', '', 'JPY'],
    ['unknown', '999', 'EUR'],
    ['amount', '', 'JPY'],
    ['amount', '0', 'JPY'],
    ['amount', '12.5', 'JPY'],
    ['amount', '12.5', 'EUR'],
    ['amount', '-1', 'USD'],
    ['amount', 'abc', 'JPY'],
  ];
  const musts = ['', 'p1\np2', 'p1\n兼六園\np1'];

  const all: ConditionForm[] = [];
  for (const area of areas)
    for (const startDate of dates)
      for (const endDate of dates)
        for (const timeZone of zones)
          for (const transportMode of modes)
            for (const [budgetMode, budgetAmount, budgetCurrency] of budgets)
              for (const mustVisit of musts)
                all.push({ area, startDate, endDate, timeZone, transportMode, budgetMode, budgetAmount, budgetCurrency, mustVisit });

  it('covers a large input space', () => {
    expect(all.length).toBeGreaterThan(10000);
  });

  it('a request exists exactly when there are no errors, and every request passes GenerateRequest.safeParse', () => {
    const fieldKeys: FieldKey[] = ['area', 'startDate', 'endDate', 'timeZone', 'transportMode', 'budget', 'mustVisit'];
    let requests = 0;
    for (const f of all) {
      const r = validateCondition(f);
      const hasErrors = Object.keys(r.errors).length > 0;
      if (hasErrors !== (r.request === null)) throw new Error(`request/errors mismatch for ${JSON.stringify(f)}`);
      for (const k of Object.keys(r.errors)) if (!fieldKeys.includes(k as FieldKey)) throw new Error(`unknown error key ${k}`);
      for (const k of r.missing) {
        if (!REQUIRED_FIELDS.includes(k)) throw new Error(`optional field reported missing: ${k}`);
        if (!r.errors[k]) throw new Error(`missing without error: ${k} for ${JSON.stringify(f)}`);
      }
      if (r.request) {
        requests += 1;
        if (!GenerateRequest.safeParse(r.request).success) throw new Error(`invalid request for ${JSON.stringify(f)}`);
        const c = r.request.constraints;
        if (r.request.mode !== 'generate') throw new Error('mode must be generate');
        if ('mustVisit' in c) throw new Error('mustVisit must never be sent (no place picker yet)');
        if ((c.preferences ?? []).some(p => !p.startsWith(MUST_VISIT_PREFIX) || p.length > MAX_PREFERENCE_LENGTH)) throw new Error('bad preference');
        if ((c.preferences ?? []).length > MAX_PREFERENCES) throw new Error('too many preferences');
        if (f.budgetMode === 'unknown' && c.budget !== null) throw new Error('unknown budget became a value');
        if (f.budgetMode === 'amount' && (c.budget === null || c.budget === undefined)) throw new Error('amount budget lost');
        if (c.endDate < c.startDate) throw new Error('end before start was sent');
        if (c.area !== c.area.trim() || c.area === '') throw new Error('area not trimmed/blank');
      }
    }
    expect(requests).toBeGreaterThan(100);
  });

  it('is pure and does not mutate the form', () => {
    const f = Object.freeze({ ...sampleForm, mustVisit: 'a\nb' });
    const a = validateCondition(f);
    const b = validateCondition(f);
    expect(a).toEqual(b);
  });
});
