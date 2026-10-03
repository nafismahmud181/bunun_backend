import { describe, expect, it } from 'vitest';
import { reportRange, todayInDhaka } from '../src/services/reports.js';

describe('report date range', () => {
  it('defaults to the last 30 days, today included, in Bangladesh time', () => {
    const r = reportRange({});
    expect(r.to).toBe(todayInDhaka());
    expect(r.days).toBe(30);
    expect(r.bucket).toBe('day');
  });

  it('compares with the same number of days just before', () => {
    expect(reportRange({ from: '2026-09-01', to: '2026-09-30' })).toMatchObject({
      days: 30,
      prevFrom: '2026-08-02',
      prevTo: '2026-08-31',
    });
    expect(reportRange({ from: '2026-03-01', to: '2026-03-01' })).toMatchObject({
      days: 1,
      prevFrom: '2026-02-28',
      prevTo: '2026-02-28',
    });
  });

  it('groups long ranges by month', () => {
    expect(reportRange({ from: '2026-01-01', to: '2026-03-31' }).bucket).toBe('day'); // 90 days
    expect(reportRange({ from: '2026-01-01', to: '2026-09-30' }).bucket).toBe('month');
  });

  it('refuses reversed, too long or malformed ranges', () => {
    expect(() => reportRange({ from: '2026-09-30', to: '2026-09-01' })).toThrow('on or before');
    expect(() => reportRange({ from: '2025-01-01', to: '2026-09-30' })).toThrow('at most 366');
    expect(() => reportRange({ from: '30-09-2026' })).toThrow('2026-09-30');
  });
});
