import * as SecureStore from 'expo-secure-store';
import { createMobileClient, createMobilePgpService } from './pgp';

const secureStore = SecureStore as unknown as { __store: Map<string, string> };

interface CapturedRequest {
  url: string;
  method: string;
  auth: string | null;
  body: Record<string, unknown> | null;
}

let requests: CapturedRequest[];
let keyringPayload: unknown;

function installFetchMock() {
  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String(input);
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);
    requests.push({
      url,
      method,
      auth: headers.get('Authorization'),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });

    let data: unknown = null;
    if (url.endsWith('/api/pgp/contacts') && method === 'GET') data = [];
    if (url.endsWith('/api/pgp/keyring') && method === 'GET') data = keyringPayload;
    return new Response(JSON.stringify({ success: true, data }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

describe('mobile PGP service (P3.4/P3.5)', () => {
  beforeEach(() => {
    requests = [];
    keyringPayload = null;
    secureStore.__store.clear();
    installFetchMock();
  });

  it('binds the shared client to the device SecureStore token', async () => {
    secureStore.__store.set('e2Mail_token', 'tok-123');

    const client = createMobileClient('https://mail.example.com');
    await client.request('/pgp/contacts');

    expect(requests[0]).toMatchObject({
      url: 'https://mail.example.com/api/pgp/contacts',
      auth: 'Bearer tok-123',
    });
  });

  it('generates a key on device and backs up the encrypted keyring (P3.4)', async () => {
    const pgp = createMobilePgpService('https://mail.example.com');

    const keyPair = await pgp.generateKey('Me', 'me@example.com', 'passphrase');

    expect(keyPair.publicKeyArmored).toContain('BEGIN PGP PUBLIC KEY BLOCK');
    expect(keyPair.privateKeyArmored).toContain('BEGIN PGP PRIVATE KEY BLOCK');

    await new Promise((resolve) => setTimeout(resolve, 20));
    const backup = requests.find((r) => r.url.endsWith('/api/pgp/keyring') && r.method === 'POST');
    expect(backup).toBeDefined();
    expect(backup?.body).toMatchObject({
      publicKeyArmored: keyPair.publicKeyArmored,
      fingerprint: keyPair.fingerprint,
    });
  });

  it('loads the cloud keyring into memory (P3.4)', async () => {
    keyringPayload = {
      email: 'me@example.com',
      publicKeyArmored: 'PUB',
      encryptedPrivateKeyArmored: 'ENC',
      fingerprint: 'FP',
      keyId: 'KEYID',
      updatedAt: '2026-09-10T00:00:00.000Z',
    };
    const pgp = createMobilePgpService('https://mail.example.com');

    const loaded = await pgp.fetchKeyringFromCloud();

    expect(loaded?.keyId).toBe('KEYID');
    expect(pgp.getKeyPair()?.keyId).toBe('KEYID');
  });
});
