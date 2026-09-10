import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../api/client';
import { createPgpService } from './service';

interface Call {
  endpoint: string;
  method: string;
  body: Record<string, unknown> | undefined;
}

function makeClient(handler: (call: Call) => unknown) {
  const calls: Call[] = [];
  const client: ApiClient = {
    request: async <T,>(endpoint: string, options?: RequestInit): Promise<T> => {
      const call: Call = {
        endpoint,
        method: options?.method ?? 'GET',
        body: options?.body ? JSON.parse(String(options.body)) : undefined,
      };
      calls.push(call);
      return handler(call) as T;
    },
    raw: async () => new Response(),
    getToken: async () => null,
    setToken: async () => {},
    clearToken: async () => {},
    translate: (key: string) => key,
  };
  return { client, calls };
}

/** Default handler: no cloud keyring and no contact keys saved. */
function emptyHandler(call: Call): unknown {
  if (call.endpoint === '/pgp/contacts' && call.method === 'GET') return [];
  return null;
}

describe('createPgpService', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('generates an Ed25519 key pair and backs the encrypted keyring up (P3.4)', async () => {
    const { client, calls } = makeClient(emptyHandler);
    const pgp = createPgpService(client);

    const keyPair = await pgp.generateKey('Alice', 'alice@example.com', 'secret');

    expect(keyPair.keyId).toMatch(/^[0-9A-F]+$/);
    expect(keyPair.publicKeyArmored).toContain('BEGIN PGP PUBLIC KEY BLOCK');
    expect(keyPair.privateKeyArmored).toContain('BEGIN PGP PRIVATE KEY BLOCK');
    expect(pgp.getKeyPair()).toEqual(keyPair);

    await vi.waitFor(() => {
      expect(calls.some((c) => c.endpoint === '/pgp/keyring' && c.method === 'POST')).toBe(true);
    });
    const sync = calls.find((c) => c.endpoint === '/pgp/keyring' && c.method === 'POST');
    expect(sync?.body).toMatchObject({
      publicKeyArmored: keyPair.publicKeyArmored,
      encryptedPrivateKeyArmored: keyPair.privateKeyArmored,
      fingerprint: keyPair.fingerprint,
    });
  });

  it('fetches and deletes the cloud keyring (P3.4)', async () => {
    const payload = {
      email: 'alice@example.com',
      publicKeyArmored: 'PUB',
      encryptedPrivateKeyArmored: 'ENC',
      fingerprint: 'FP',
      keyId: 'KEYID',
      updatedAt: '2026-09-10T00:00:00.000Z',
    };
    const { client, calls } = makeClient((call) => {
      if (call.endpoint === '/pgp/keyring' && call.method === 'GET') return payload;
      if (call.endpoint === '/pgp/keyring' && call.method === 'DELETE') return null;
      return emptyHandler(call);
    });
    const pgp = createPgpService(client);

    const fetched = await pgp.fetchKeyringFromCloud();
    expect(fetched?.keyId).toBe('KEYID');
    expect(fetched?.privateKeyArmored).toBe('ENC');
    expect(pgp.getKeyPair()?.keyId).toBe('KEYID');

    await pgp.deleteKeyringFromCloud();
    expect(calls).toContainEqual({ endpoint: '/pgp/keyring', method: 'DELETE', body: undefined });
  });

  it('lists, saves, bulk-imports and removes contact public keys (P3.5)', async () => {
    const { client, calls } = makeClient((call) => {
      if (call.endpoint === '/pgp/contacts' && call.method === 'GET') {
        return [{ email: 'bob@example.com', publicKeyArmored: 'PUB', fingerprint: 'FP' }];
      }
      if (call.endpoint === '/pgp/contacts' && call.method === 'POST') {
        return { contact: call.body };
      }
      if (call.endpoint === '/pgp/contacts/bulk') return { saved: 1, skipped: [] };
      if (call.endpoint === '/pgp/contacts/import') {
        return { saved: 2, skipped: [], invalid: 0 };
      }
      return null;
    });
    const pgp = createPgpService(client);

    expect(await pgp.getContactKeys()).toHaveLength(1);

    const carol = await pgp.generateKey('Carol', 'other@example.com');
    const saved = await pgp.saveContactKey('carol@example.com', carol.publicKeyArmored);
    expect(saved.email).toBe('carol@example.com');

    const bulk = await pgp.saveContactKeysBulk([
      {
        email: 'dave@example.com',
        name: 'Dave',
        keyId: 'K',
        fingerprint: 'F',
        armoredKey: 'PUB',
        isPrivate: false,
      },
      {
        email: '',
        name: '',
        keyId: 'K',
        fingerprint: 'F',
        armoredKey: 'PRIV',
        isPrivate: true,
      },
    ]);
    expect(bulk.saved).toHaveLength(1);
    expect(bulk.failed).toHaveLength(1);
    expect(bulk.failed[0]).toMatchObject({ email: '', error: 'pgp.privateNotContact' });

    expect(await pgp.importContactKeysFromFile('ARMORED')).toMatchObject({ saved: 2 });

    await pgp.removeContactKey('Carol@Example.com');
    expect(calls).toContainEqual({
      endpoint: '/pgp/contacts/carol%40example.com',
      method: 'DELETE',
      body: undefined,
    });
  });

  it('round-trips encrypt/decrypt with a passphrase and verifies the signature (P3.3)', async () => {
    const { client } = makeClient(emptyHandler);
    const pgp = createPgpService(client);

    const alice = await pgp.generateKey('Alice', 'alice@example.com', 'alice-pass');
    const bob = await pgp.generateKey('Bob', 'bob@example.com', 'bob-pass');
    pgp.saveKeyPair(alice);

    const encrypted = await pgp.encrypt({
      text: 'top secret',
      recipientPublicKeysArmored: [bob.publicKeyArmored],
      signerPrivateKeyArmored: alice.privateKeyArmored,
      passphrase: 'alice-pass',
    });
    expect(encrypted).toContain('BEGIN PGP MESSAGE');

    const decrypted = await pgp.decrypt({
      armoredMessage: encrypted,
      privateKeyArmored: bob.privateKeyArmored,
      passphrase: 'bob-pass',
      senderPublicKeyArmored: alice.publicKeyArmored,
    });
    expect(decrypted.data).toBe('top secret');
    expect(decrypted.verified).toBe(true);
    expect(decrypted.signatureKeyId).toBe(alice.keyId);
  });

  it('rejects a wrong passphrase without leaking the private key (P3.3)', async () => {
    const { client } = makeClient(emptyHandler);
    const pgp = createPgpService(client);
    const alice = await pgp.generateKey('Alice', 'alice@example.com', 'right');
    const bob = await pgp.generateKey('Bob', 'bob@example.com', 'bobpass');
    pgp.saveKeyPair(alice);

    const encrypted = await pgp.encrypt({
      text: 'hi',
      recipientPublicKeysArmored: [bob.publicKeyArmored],
    });

    await expect(
      pgp.decrypt({
        armoredMessage: encrypted,
        privateKeyArmored: bob.privateKeyArmored,
        passphrase: 'wrong',
      })
    ).rejects.toThrow('pgp.badPassphraseDecrypt');
  });

  it('parses multiple public keys, skipping private keys (P3.5)', async () => {
    const { client } = makeClient(emptyHandler);
    const pgp = createPgpService(client);
    const alice = await pgp.generateKey('Alice', 'alice@example.com');
    const bob = await pgp.generateKey('Bob', 'bob@example.com');

    const parsed = await pgp.parseMultipleKeys(
      `${alice.publicKeyArmored}\n${bob.publicKeyArmored}`
    );
    expect(parsed.map((k) => k.email).sort()).toEqual(['alice@example.com', 'bob@example.com']);
    expect(parsed.every((k) => !k.isPrivate)).toBe(true);
  });
});
