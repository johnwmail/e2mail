import { runCryptoSmoke } from './smoke';

describe('runCryptoSmoke (P3.3 harness)', () => {
  it('passes keygen, encrypt/decrypt, and sign/verify', async () => {
    const result = await runCryptoSmoke();

    expect(result.steps.map((s) => s.name)).toEqual([
      'keygen (Ed25519)',
      'encrypt + sign',
      'decrypt + verify',
      'detached sign + verify',
    ]);
    expect(result.steps.map((s) => s.ok)).toEqual([true, true, true, true]);
    expect(result.ok).toBe(true);
    expect(result.environment.textEncoder).toBe(true);
    expect(result.environment.textDecoder).toBe(true);
  }, 60_000);
});
