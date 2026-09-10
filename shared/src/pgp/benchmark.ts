import * as openpgp from 'openpgp';

export interface PgpBenchmarkResult {
  iterations: number;
  keygenMs: number;
  encryptMs: number;
  decryptMs: number;
  signMs: number;
  verifyMs: number;
}

async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const start = performance.now();
  const value = await fn();
  return [value, performance.now() - start];
}

/**
 * Measure the OpenPGP operations that block the UI on unlock / send (P3.7).
 * Run on a mid-range device via a development build; the numbers in MOBILE.md
 * are the reference thresholds to compare against.
 */
export async function benchmarkPgp(iterations = 3): Promise<PgpBenchmarkResult> {
  const [keyPair, keygenMs] = await timed(() =>
    openpgp.generateKey({
      type: 'ecc',
      curve: 'ed25519Legacy',
      userIDs: [{ name: 'Bench', email: 'bench@example.com' }],
    })
  );
  const publicKey = await openpgp.readKey({ armoredKey: keyPair.publicKey });
  const privateKey = await openpgp.readPrivateKey({ armoredKey: keyPair.privateKey });

  let encryptTotal = 0;
  let decryptTotal = 0;
  let signTotal = 0;
  let verifyTotal = 0;

  for (let i = 0; i < iterations; i += 1) {
    const text = `benchmark message ${i} `.repeat(64);

    const plain = await openpgp.createMessage({ text });
    const [, encryptMs] = await timed(() =>
      openpgp.encrypt({
        message: plain,
        encryptionKeys: publicKey,
        signingKeys: privateKey,
      })
    );
    encryptTotal += encryptMs;

    const message = await openpgp.createMessage({ text });
    const [armoredSignature, signMs] = await timed(() =>
      openpgp.sign({ message, signingKeys: privateKey, detached: true })
    );
    signTotal += signMs;

    const signature = await openpgp.readSignature({ armoredSignature: armoredSignature });
    const [, verifyMs] = await timed(() =>
      openpgp.verify({ message, signature, verificationKeys: publicKey })
    );
    verifyTotal += verifyMs;

    const plainForEncrypt = await openpgp.createMessage({ text });
    const encrypted = await openpgp.encrypt({
      message: plainForEncrypt,
      encryptionKeys: publicKey,
      signingKeys: privateKey,
    });
    const [, decryptMs] = await timed(async () => {
      const read = await openpgp.readMessage({ armoredMessage: encrypted as string });
      return openpgp.decrypt({
        message: read,
        decryptionKeys: privateKey,
        verificationKeys: publicKey,
      });
    });
    decryptTotal += decryptMs;
  }

  return {
    iterations,
    keygenMs,
    encryptMs: encryptTotal / iterations,
    decryptMs: decryptTotal / iterations,
    signMs: signTotal / iterations,
    verifyMs: verifyTotal / iterations,
  };
}
