import { describe, expect, it } from 'vitest';
import { ProfitPlan } from '../src/schemas/profit-plan.js';
import { DEFAULT_PLAN } from '../src/services/profit-plan.js';

describe('profit plan', () => {
  it('ships defaults that pass its own validation', () => {
    expect(ProfitPlan.parse(DEFAULT_PLAN)).toEqual(DEFAULT_PLAN);
  });

  it('needs three margins and twelve months', () => {
    expect(ProfitPlan.safeParse({ ...DEFAULT_PLAN, margins: [40] }).success).toBe(false);
    expect(ProfitPlan.safeParse({ ...DEFAULT_PLAN, orders: [1, 2, 3] }).success).toBe(false);
  });

  it('refuses percentages over 100 and negative costs', () => {
    const per = DEFAULT_PLAN.perOrder;
    expect(ProfitPlan.safeParse({ ...DEFAULT_PLAN, perOrder: { ...per, returnRate: 140 } }).success).toBe(false);
    expect(ProfitPlan.safeParse({ ...DEFAULT_PLAN, monthly: [{ label: 'Ads', amount: -5, note: '' }] }).success).toBe(
      false,
    );
  });
});
