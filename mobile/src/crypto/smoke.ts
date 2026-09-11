import * as openpgp from 'openpgp';
import { benchmarkPgp, type PgpBenchmarkResult } from '@e2mail/shared/pgp';

export interface SmokeStep {
  name: string;
  ok: boolean;
  ms: number;
  detail?: string;
}

export interface CryptoEnvironment {
  subtle: boolean;
  getRandomValues: boolean;
  textEncoder: boolean;
  textDecoder: boolean;
}

export interface CryptoSmokeResult {
  ok: boolean;
  environment: CryptoEnvironment;
  steps: SmokeStep[];
  benchmark: PgpBenchmarkResult | null;
}

export function readCryptoEnvironment(): CryptoEnvironment {
  const c = globalThis.crypto as Crypto | undefined;
  return {
    subtle: Boolean(c?.subtle),
    getRandomValues: typeof c?.getRandomValues === 'function',
    textEncoder: typeof globalThis.TextEncoder !== 'undefined',
    textDecoder: typeof globalThis.TextDecoder !== 'undefined',
  };
}

async function smokeStep(
  name: string,
  fn: () => Promise<string | undefined>
): Promise<SmokeStep> {
  const start = performance.now();
  try {
    const detail = await fn();
    return { name, ok: true, ms: performance.now() - start, detail };
  } catch (err) {
    return {
      name,
      ok: false,
      ms: performance.now() - start,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * On-device counterpart to the shared vitest round-trip (P3.3). Unlike Node,
 * this proves `react-native-quick-crypto`'s `subtle` backend is actually wired
 * into OpenPGP.js on the RN runtime.
 */
export async function runCryptoSmoke(
  options: { benchmark?: boolean; iterations?: number } = {}
): Promise<CryptoSmokeResult> {
  const environment = readCryptoEnvironment();
  const steps: SmokeStep[] = [];
  const plaintext = `e2mail smoke ${Date.now()}`;
  let publicKeyArmored = '';
  let privateKeyArmored = '';

  steps.push(
    await smokeStep('keygen (Ed25519)', async () => {
      const generated = await openpgp.generateKey({
        type: 'ecc',
        curve: 'ed25519Legacy',
        userIDs: [{ name: 'Smoke', email: 'smoke@example.com' }],
      });
      publicKeyArmored = generated.publicKey;
      privateKeyArmored = generated.privateKey;
      return (await openpgp.readKey({ armoredKey: publicKeyArmored }))
        .getKeyID()
        .toHex()
        .toUpperCase();
    })
  );

  let encrypted = '';
  steps.push(
    await smokeStep('encrypt + sign', async () => {
      const message = await openpgp.createMessage({ text: plaintext });
      encrypted = (await openpgp.encrypt({
        message,
        encryptionKeys: await openpgp.readKey({ armoredKey: publicKeyArmored }),
        signingKeys: await openpgp.readPrivateKey({ armoredKey: privateKeyArmored }),
      })) as string;
      return `${encrypted.length} chars`;
    })
  );

  steps.push(
    await smokeStep('decrypt + verify', async () => {
      const message = await openpgp.readMessage({ armoredMessage: encrypted });
      const { data, signatures } = await openpgp.decrypt({
        message,
        decryptionKeys: await openpgp.readPrivateKey({ armoredKey: privateKeyArmored }),
        verificationKeys: await openpgp.readKey({ armoredKey: publicKeyArmored }),
      });
      const verified = signatures?.[0] ? await signatures[0].verified : false;
      if (String(data) !== plaintext) throw new Error('plaintext mismatch');
      if (!verified) throw new Error('signature not verified');
      return 'signature verified';
    })
  );

  steps.push(
    await smokeStep('detached sign + verify', async () => {
      const message = await openpgp.createMessage({ text: plaintext });
      const armoredSignature = await openpgp.sign({
        message,
        signingKeys: await openpgp.readPrivateKey({ armoredKey: privateKeyArmored }),
        detached: true,
      });
      const signature = await openpgp.readSignature({ armoredSignature });
      const verified = await openpgp.verify({
        message,
        signature,
        verificationKeys: await openpgp.readKey({ armoredKey: publicKeyArmored }),
      });
      if (!(await verified.signatures[0].verified)) throw new Error('not verified');
      return 'signature verified';
    })
  );

  let benchmark: PgpBenchmarkResult | null = null;
  if (options.benchmark) {
    benchmark = await benchmarkPgp(options.iterations ?? 3);
  }

  return {
    ok: steps.every((s) => s.ok),
    environment,
    steps,
    benchmark,
  };
}
