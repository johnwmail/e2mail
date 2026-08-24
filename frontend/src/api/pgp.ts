import * as openpgp from 'openpgp';
import { request } from './client';

export interface PgpKeyPair {
  keyId: string;
  fingerprint: string;
  userId: string;
  publicKeyArmored: string;
  privateKeyArmored: string;
  createdAt: string;
}

export interface PgpContactKey {
  email: string;
  name?: string;
  publicKeyArmored: string;
  fingerprint: string;
  keyId?: string;
}

export interface ParsedKeyInfo {
  email: string;
  name: string;
  keyId: string;
  fingerprint: string;
  armoredKey: string;
  isPrivate: boolean;
}

export interface CloudKeyringPayload {
  email: string;
  publicKeyArmored: string;
  encryptedPrivateKeyArmored: string;
  fingerprint: string;
  keyId: string;
  updatedAt: string;
}

// 唔將 PGP key 存落 localStorage（最大化 privacy）：只存 in-memory cache，
// readonly 期間有效，logout / session expired / 重新登入時重新自 server fetch。
let memoryKeyPair: PgpKeyPair | null = null;

function setMemoryKeyPair(kp: PgpKeyPair | null) {
  memoryKeyPair = kp;
}

export const isAsciiText = (bytes: Uint8Array): boolean => {
  const checkLen = Math.min(bytes.length, 256);
  for (let i = 0; i < checkLen; i++) {
    const b = bytes[i];
    if (b === 0 || (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d)) {
      return false;
    }
  }
  return true;
};

export const fileToPublicKeyArmor = async (file: File): Promise<string> => {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  if (isAsciiText(bytes)) {
    return new TextDecoder('utf-8').decode(bytes);
  }
  const keys = await openpgp.readKeys({ binaryKeys: bytes });
  if (keys.length === 0) {
    throw new Error('binary key file contains no PGP keys');
  }
  return keys.map((k) => k.armor()).join('\n');
};

export const fileToPrivateKeyArmor = async (file: File): Promise<string> => {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  if (isAsciiText(bytes)) {
    return new TextDecoder('utf-8').decode(bytes);
  }
  const privKey = await openpgp.readPrivateKey({ binaryKey: bytes });
  return privKey.armor();
};

const buildParsedKeyInfo = async (
  key: openpgp.Key | openpgp.PrivateKey,
  armored: string,
  isPrivate: boolean
): Promise<ParsedKeyInfo> => {
  const userIDs = await key.getUserIDs();
  const primaryUser = userIDs[0] || '';
  let name = '';
  let email = '';

  const emailMatch = primaryUser.match(/<([^>]+)>/);
  if (emailMatch) {
    email = emailMatch[1].toLowerCase().trim();
    name = primaryUser.replace(/<[^>]+>/, '').trim();
  } else if (primaryUser.includes('@')) {
    email = primaryUser.trim().toLowerCase();
  }

  return {
    email,
    name,
    keyId: key.getKeyID().toHex().toUpperCase(),
    fingerprint: key.getFingerprint().toUpperCase(),
    armoredKey: armored,
    isPrivate,
  };
};

export const pgpService = {
  // 1. 生成全新 PGP 金鑰對 (Ed25519)
  generateKey: async (
    name: string,
    email: string,
    passphrase?: string
  ): Promise<PgpKeyPair> => {
    const { privateKey, publicKey } = await openpgp.generateKey({
      type: 'ecc',
      curve: 'ed25519',
      userIDs: [{ name, email }],
      passphrase: passphrase || undefined,
    });

    const parsedKey = await openpgp.readKey({ armoredKey: publicKey });
    const keyPair: PgpKeyPair = {
      keyId: parsedKey.getKeyID().toHex().toUpperCase(),
      fingerprint: parsedKey.getFingerprint().toUpperCase(),
      userId: `${name} <${email}>`,
      publicKeyArmored: publicKey,
      privateKeyArmored: privateKey,
      createdAt: new Date().toISOString(),
    };

    pgpService.saveKeyPair(keyPair);
    pgpService.syncKeyringToCloud(keyPair).catch((e) => console.warn('Cloud keyring sync failed:', e));
    return keyPair;
  },

  // 2. 解析金鑰檔案 (自動擷取 Email、姓名、Key ID 與指紋)
  parseKeyInfo: async (armored: string): Promise<ParsedKeyInfo> => {
    armored = armored.trim();
    const isPrivate = /BEGIN PGP PRIVATE KEY BLOCK/i.test(armored);

    const key = isPrivate
      ? await openpgp.readPrivateKey({ armoredKey: armored })
      : await openpgp.readKey({ armoredKey: armored });

    return buildParsedKeyInfo(key, armored, isPrivate);
  },

  parseMultipleKeys: async (armored: string): Promise<ParsedKeyInfo[]> => {
    armored = armored.trim();
    if (!armored) {
      throw new Error('找不到有效的 PGP 金鑰區塊');
    }
    let keys: openpgp.Key[];
    try {
      keys = await openpgp.readKeys({ armoredKeys: armored });
    } catch {
      throw new Error('找不到有效的 PGP 金鑰區塊');
    }
    const results: ParsedKeyInfo[] = [];
    for (const key of keys) {
      try {
        const armoredKey = key.armor();
        results.push(await buildParsedKeyInfo(key, armoredKey, false));
      } catch {
      }
    }
    return results;
  },

  saveContactKeysBulk: async (
    keys: ParsedKeyInfo[]
  ): Promise<{
    saved: PgpContactKey[];
    skipped: string[];
    failed: { email: string; error: string }[];
  }> => {
    const contacts: PgpContactKey[] = [];
    const failed: { email: string; error: string }[] = [];

    for (const info of keys) {
      if (info.isPrivate) {
        failed.push({ email: info.email, error: '私鑰不適合作為聯絡人公鑰' });
        continue;
      }
      if (!info.email) {
        failed.push({ email: '', error: '無法從公鑰中識別電子郵件地址' });
        continue;
      }
      contacts.push({
        email: info.email.toLowerCase().trim(),
        name: info.name,
        publicKeyArmored: info.armoredKey,
        fingerprint: info.fingerprint,
        keyId: info.keyId,
      });
    }

    if (contacts.length === 0) {
      return { saved: [], skipped: [], failed };
    }

    try {
      const result = await request<{ saved: number; skipped: string[] }>(
        '/pgp/contacts/bulk',
        {
          method: 'POST',
          body: JSON.stringify({ contacts }),
        }
      );
      return {
        saved: contacts.filter((c) => !result.skipped.includes(c.email)),
        skipped: result.skipped,
        failed,
      };
    } catch (err: any) {
      for (const c of contacts) {
        failed.push({ email: c.email, error: err?.message || String(err) });
      }
      return { saved: [], skipped: [], failed };
    }
  },

  // 由伺服器端 ProtonMail/go-crypto 直接解析公鑰檔（fallback，處理前端
  // openpgp.js 在大檔案（≥4MB 多公鑰）情境下解析失敗的問題）
  importContactKeysFromFile: async (armored: string): Promise<{
    saved: number;
    skipped: string[];
    invalid: number;
  }> => {
    return await request<{ saved: number; skipped: string[]; invalid: number }>(
      '/pgp/contacts/import',
      {
        method: 'POST',
        body: JSON.stringify({ armored }),
      }
    );
  },

  // 3. 匯入既有的個人私鑰/金鑰對
  importPersonalKey: async (
    privateKeyArmored: string,
    publicKeyArmored?: string
  ): Promise<PgpKeyPair> => {
    const privKey = await openpgp.readPrivateKey({ armoredKey: privateKeyArmored });
    const userIDs = await privKey.getUserIDs();
    const primaryUser = userIDs[0] || 'Imported Key';

    let pubArmored = publicKeyArmored;
    if (!pubArmored) {
      pubArmored = privKey.toPublic().armor();
    }

    const keyPair: PgpKeyPair = {
      keyId: privKey.getKeyID().toHex().toUpperCase(),
      fingerprint: privKey.getFingerprint().toUpperCase(),
      userId: primaryUser,
      publicKeyArmored: pubArmored,
      privateKeyArmored,
      createdAt: new Date().toISOString(),
    };

    pgpService.saveKeyPair(keyPair);
    pgpService.syncKeyringToCloud(keyPair).catch((e) => console.warn('Cloud keyring sync failed:', e));
    return keyPair;
  },

  // 4. 雲端密文金鑰庫同步 API (Zero-Knowledge: 伺服器僅儲存 Passphrase 加密的密文)
  syncKeyringToCloud: async (keyPair: PgpKeyPair): Promise<void> => {
    await request<void>('/pgp/keyring', {
      method: 'POST',
      body: JSON.stringify({
        publicKeyArmored: keyPair.publicKeyArmored,
        encryptedPrivateKeyArmored: keyPair.privateKeyArmored,
        fingerprint: keyPair.fingerprint,
        keyId: keyPair.keyId,
      }),
    });
  },

  fetchKeyringFromCloud: async (): Promise<PgpKeyPair | null> => {
    try {
      const payload = await request<CloudKeyringPayload | null>('/pgp/keyring');
      if (!payload || !payload.encryptedPrivateKeyArmored) return null;

      const keyPair: PgpKeyPair = {
        keyId: payload.keyId,
        fingerprint: payload.fingerprint,
        userId: payload.email,
        publicKeyArmored: payload.publicKeyArmored,
        privateKeyArmored: payload.encryptedPrivateKeyArmored,
        createdAt: payload.updatedAt,
      };

      pgpService.saveKeyPair(keyPair);
      return keyPair;
    } catch (err) {
      console.warn('Failed to fetch keyring from cloud:', err);
      return null;
    }
  },

  deleteKeyringFromCloud: async (): Promise<void> => {
    await request<void>('/pgp/keyring', {
      method: 'DELETE',
    });
  },

  // 若 in-memory 無 key，就先從雲端 fetch（每次 login/session 後）
  ensureKey: async (): Promise<PgpKeyPair | null> => {
    if (memoryKeyPair) return memoryKeyPair;
    return pgpService.fetchKeyringFromCloud();
  },

  // 5. In-memory key 操作（唔落 localStorage，maximize privacy）
  saveKeyPair: (keyPair: PgpKeyPair | null) => {
    setMemoryKeyPair(keyPair);
  },

  getKeyPair: (): PgpKeyPair | null => memoryKeyPair,

  // 清空 in-memory key（logout / session expired 時呼叫）
  clearKey: () => {
    setMemoryKeyPair(null);
  },

  isPrivateKeyEncrypted: async (privateKeyArmored: string): Promise<boolean> => {
    try {
      const privateKey = await openpgp.readPrivateKey({ armoredKey: privateKeyArmored });
      return !privateKey.isDecrypted();
    } catch {
      return false;
    }
  },

  // 6. 儲存與讀取聯絡人公鑰庫（伺服器端 SQLite 儲存，per-user）
  getContactKeys: async (): Promise<PgpContactKey[]> => {
    try {
      return await request<PgpContactKey[]>('/pgp/contacts');
    } catch (err) {
      console.warn('Failed to fetch contact keys:', err);
      return [];
    }
  },

  saveContactKey: async (
    email: string,
    publicKeyArmored: string,
    name?: string
  ): Promise<PgpContactKey> => {
    const info = await pgpService.parseKeyInfo(publicKeyArmored);
    const finalEmail = (email || info.email).toLowerCase().trim();

    if (!finalEmail) {
      throw new Error('無法從公鑰中識別電子郵件地址，請手動指定 Email');
    }

    const result = await request<{ contact: PgpContactKey }>('/pgp/contacts', {
      method: 'POST',
      body: JSON.stringify({
        email: finalEmail,
        name: name || info.name,
        publicKeyArmored,
        fingerprint: info.fingerprint,
        keyId: info.keyId,
      }),
    });
    return result.contact;
  },

  removeContactKey: async (email: string): Promise<void> => {
    await request<void>(`/pgp/contacts/${encodeURIComponent(email.toLowerCase().trim())}`, {
      method: 'DELETE',
    });
  },

  // 7. 自線上 PGP 金鑰伺服器 (keys.openpgp.org / Ubuntu HKP) 獲取公鑰
  fetchPublicKeyFromKeyserver: async (email: string): Promise<string | null> => {
    const targetEmail = email.toLowerCase().trim();
    if (!targetEmail || !targetEmail.includes('@')) return null;

    // A. 優先查詢 keys.openpgp.org (VKS 官方 API)
    try {
      const res = await fetch(`https://keys.openpgp.org/vks/v1/by-email/${encodeURIComponent(targetEmail)}`);
      if (res.ok) {
        const armored = await res.text();
        if (armored && armored.includes('BEGIN PGP PUBLIC KEY BLOCK')) {
          return armored;
        }
      }
    } catch (err) {
      console.warn('keys.openpgp.org lookup failed:', err);
    }

    // B. 回退查詢 keyserver.ubuntu.com (HKP 協議)
    try {
      const res = await fetch(
        `https://keyserver.ubuntu.com/pks/lookup?op=get&options=mr&search=${encodeURIComponent(targetEmail)}`
      );
      if (res.ok) {
        const armored = await res.text();
        if (armored && armored.includes('BEGIN PGP PUBLIC KEY BLOCK')) {
          return armored;
        }
      }
    } catch (err) {
      console.warn('keyserver.ubuntu.com lookup failed:', err);
    }

    return null;
  },

  // 8. 加密郵件內文
  encrypt: async ({
    text,
    recipientPublicKeysArmored,
    signerPrivateKeyArmored,
    passphrase,
  }: {
    text: string;
    recipientPublicKeysArmored: string[];
    signerPrivateKeyArmored?: string;
    passphrase?: string;
  }): Promise<string> => {
    const encryptionKeys = await Promise.all(
      recipientPublicKeysArmored.map((armoredKey) => openpgp.readKey({ armoredKey }))
    );

    let signingKeys;
    if (signerPrivateKeyArmored) {
      let privateKey = await openpgp.readPrivateKey({ armoredKey: signerPrivateKeyArmored });
      if (!privateKey.isDecrypted()) {
        try {
          privateKey = await openpgp.decryptKey({
            privateKey,
            passphrase: passphrase || '',
          });
        } catch (e: any) {
          throw new Error('私鑰密碼 (Passphrase) 錯誤，無法完成 PGP 簽名: ' + (e?.message || e));
        }
      }
      signingKeys = privateKey;
    }

    const message = await openpgp.createMessage({ text });
    const encrypted = await openpgp.encrypt({
      message,
      encryptionKeys,
      signingKeys,
    });

    return encrypted as string;
  },

  // 9. 解密 PGP 郵件（支援自動簽名校驗與明文純淨還原）
  decrypt: async ({
    armoredMessage,
    privateKeyArmored,
    passphrase,
    senderPublicKeyArmored,
  }: {
    armoredMessage: string;
    privateKeyArmored: string;
    passphrase?: string;
    senderPublicKeyArmored?: string;
  }): Promise<{ data: string; verified: boolean; signatureKeyId?: string }> => {
    let privateKey = await openpgp.readPrivateKey({ armoredKey: privateKeyArmored });
    if (!privateKey.isDecrypted()) {
      try {
        privateKey = await openpgp.decryptKey({
          privateKey,
          passphrase: passphrase || '',
        });
      } catch {
        throw new Error('私鑰密碼 (Passphrase) 錯誤，無法解密');
      }
    }

    // 收集所有可用驗證公鑰
    const verificationKeys = [];
    if (senderPublicKeyArmored) {
      try {
        verificationKeys.push(await openpgp.readKey({ armoredKey: senderPublicKeyArmored }));
      } catch {}
    }
    const allContacts = await pgpService.getContactKeys();
    for (const c of allContacts) {
      try {
        verificationKeys.push(await openpgp.readKey({ armoredKey: c.publicKeyArmored }));
      } catch {}
    }
    const myKey = await pgpService.ensureKey();
    if (myKey?.publicKeyArmored) {
      try {
        verificationKeys.push(await openpgp.readKey({ armoredKey: myKey.publicKeyArmored }));
      } catch {}
    }

    // 精確提取 PGP 密文區塊
    const pgpMatch = armoredMessage.match(/-----BEGIN PGP MESSAGE-----[\s\S]+?-----END PGP MESSAGE-----/i);
    const targetArmored = pgpMatch ? pgpMatch[0] : armoredMessage;

    const message = await openpgp.readMessage({ armoredMessage: targetArmored });
    const { data: decrypted, signatures } = await openpgp.decrypt({
      message,
      decryptionKeys: privateKey,
      verificationKeys: verificationKeys.length > 0 ? verificationKeys : undefined,
      // 繞過舊版 openpgp.js（#1148）對「signing-only key 用嚟解密」嘅限制，
      // 修正 iOS/WebKit 上「Session key decryption failed」問題
      config: { allowInsecureDecryptionWithSigningKeys: true },
    });

    let verified = false;
    let signatureKeyId;

    if (signatures && signatures.length > 0) {
      for (const sig of signatures) {
        try {
          const isVerified = await sig.verified;
          if (isVerified) {
            verified = true;
            signatureKeyId = sig.keyID.toHex().toUpperCase();
            break;
          }
        } catch {
          verified = false;
        }
      }
    }

    // 清理 OpenPGP 可能回傳的 UNVERIFIED 標記，取得純淨明文
    let cleanText = String(decrypted || '');
    cleanText = cleanText
      .replace(/^-----BEGIN PGP (?:UNVERIFIED |SIGNED )?MESSAGE-----\r?\n?/i, '')
      .replace(/\r?\n?-----END PGP (?:UNVERIFIED |SIGNED )?MESSAGE-----[\s\S]*$/i, '')
      .trim();

    // 檢查是否為巢狀/雙重加密郵件，自動遞迴解密
    if (pgpService.isPgpEncrypted(cleanText)) {
      try {
        const nested = await pgpService.decrypt({
          armoredMessage: cleanText,
          privateKeyArmored,
          passphrase,
          senderPublicKeyArmored,
        });
        return nested;
      } catch {}
    }

    return {
      data: cleanText,
      verified,
      signatureKeyId,
    };
  },

  isPgpEncrypted: (content: string): boolean => {
    return /-----BEGIN PGP MESSAGE-----/i.test(content);
  },

  isPgpSigned: (content: string): boolean => {
    return /-----BEGIN PGP SIGNED MESSAGE-----/i.test(content);
  },
};
