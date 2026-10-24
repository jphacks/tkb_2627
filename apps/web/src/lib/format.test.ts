import { describe, expect, it } from 'vitest';
import { formatMoney, formatZoned, formatDuration, UNKNOWN } from './format.ts';

describe('format', () => {
  it('shows local time and zone name', () => {
    const s = formatZoned({ utc: '2026-11-01T00:30:00Z', timeZone: 'Asia/Tokyo' });
    expect(s).toContain('09:30');
    expect(s).toContain('Asia/Tokyo');
    expect(formatZoned({ utc: '2026-11-01T00:30:00Z', timeZone: 'Europe/Paris' })).toContain('01:30');
  });
  it('null is 未取得, not zero', () => {
    expect(formatZoned(null)).toBe(UNKNOWN);
    expect(formatMoney(null)).toBe(UNKNOWN);
    expect(formatDuration(null)).toBe(UNKNOWN);
  });
  it('money uses minor units', () => {
    expect(formatMoney({ amountMinor: 1250, currency: 'EUR' })).toContain('12.50');
    expect(formatMoney({ amountMinor: 800, currency: 'JPY' })).toContain('800');
  });
});
