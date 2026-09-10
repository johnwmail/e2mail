import { describe, expect, it } from 'vitest';
import { benchmarkPgp } from './benchmark';

describe('benchmarkPgp', () => {
  it('runs every operation and reports finite per-op timings (P3.7)', async () => {
    const result = await benchmarkPgp(1);

    expect(result.iterations).toBe(1);
    for (const key of [
      'keygenMs',
      'encryptMs',
      'decryptMs',
      'signMs',
      'verifyMs',
    ] as const) {
      expect(Number.isFinite(result[key])).toBe(true);
      expect(result[key]).toBeGreaterThanOrEqual(0);
    }
    // Node reference baseline; device numbers are recorded in MOBILE.md.
    console.info('[pgp benchmark]', JSON.stringify(result, null, 2));
  }, 60_000);
});
