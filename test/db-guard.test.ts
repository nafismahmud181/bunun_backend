import { describe, expect, it } from 'vitest';
import { assertDatabaseAllowed } from '../src/lib/db-guard.js';

const SUPABASE = 'postgresql://postgres.ref:pw@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres';

describe('database guard', () => {
  it('allows the local database in development and tests', () => {
    expect(() => assertDatabaseAllowed('postgresql://bunun:bunun@localhost:5433/bunun', {})).not.toThrow();
    expect(() =>
      assertDatabaseAllowed('postgresql://bunun:bunun@127.0.0.1:5433/bunun', { NODE_ENV: 'test' }),
    ).not.toThrow();
  });

  it('refuses a remote database outside production', () => {
    expect(() => assertDatabaseAllowed(SUPABASE, {})).toThrow(/pooler\.supabase\.com/);
    expect(() => assertDatabaseAllowed(SUPABASE, { NODE_ENV: 'development' })).toThrow(/ALLOW_REMOTE_DATABASE/);
  });

  it('allows a remote database in production or when asked for explicitly', () => {
    expect(() => assertDatabaseAllowed(SUPABASE, { NODE_ENV: 'production' })).not.toThrow();
    expect(() => assertDatabaseAllowed(SUPABASE, { ALLOW_REMOTE_DATABASE: 'true' })).not.toThrow();
  });
});
