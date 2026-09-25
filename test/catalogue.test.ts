import { describe, expect, it } from 'vitest';
import { ProductListQuery, VariantsQuery } from '../src/schemas/catalogue.js';
import { stockInfo } from '../src/services/catalogue.js';

describe('stockInfo', () => {
  it('hides exact stock unless it is low', () => {
    expect(stockInfo(0)).toEqual({ stockStatus: 'out' });
    expect(stockInfo(-2)).toEqual({ stockStatus: 'out' });
    expect(stockInfo(3)).toEqual({ stockStatus: 'low', stockLeft: 3 });
    expect(stockInfo(5)).toEqual({ stockStatus: 'low', stockLeft: 5 });
    expect(stockInfo(6)).toEqual({ stockStatus: 'in_stock' });
  });
});

describe('ProductListQuery', () => {
  it('applies defaults and coerces numbers from the query string', () => {
    expect(ProductListQuery.parse({})).toEqual({ sort: 'featured', page: 1, limit: 24 });
    expect(ProductListQuery.parse({ maxPrice: '2000', page: '2', limit: '100', q: '  jute ' })).toMatchObject({
      maxPrice: 2000,
      page: 2,
      limit: 100,
      q: 'jute',
    });
  });

  it('rejects out-of-range values and unknown sorts', () => {
    expect(ProductListQuery.safeParse({ limit: '101' }).success).toBe(false);
    expect(ProductListQuery.safeParse({ page: '0' }).success).toBe(false);
    expect(ProductListQuery.safeParse({ sort: 'low' }).success).toBe(false);
  });
});

describe('VariantsQuery', () => {
  it('accepts up to 50 comma-separated SKUs', () => {
    expect(VariantsQuery.safeParse({ skus: 'BN-R1-1,BN-C1-2' }).success).toBe(true);
    const fifty = Array.from({ length: 50 }, (_, i) => `BN-X-${i}`).join(',');
    expect(VariantsQuery.safeParse({ skus: fifty }).success).toBe(true);
    expect(VariantsQuery.safeParse({ skus: fifty + ',BN-X-50' }).success).toBe(false);
    expect(VariantsQuery.safeParse({ skus: 'BN-R1-1;DROP TABLE' }).success).toBe(false);
  });
});
