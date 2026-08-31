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

// 從解密後嘅完整 MIME（multipart/mixed + protected-headers="v1"）抽取內文
// 對齊 Thunderbird RNP / Roundcube rcube_mime 解密後重建 MIME tree 嘅行為
// 會處理 base64 / quoted-printable，並將 cid: 轉為 data: URL 令 inline 圖片直接顯示
export const extractTextFromMime = (mimeText: string): string | null => {
  if (!/Content-Type:\s*multipart\//i.test(mimeText) || !/boundary=/i.test(mimeText)) return null;
  const boundaryMatch = mimeText.match(/boundary="([^"]+)"/i) || mimeText.match(/boundary=([^\s;]+)/i);
  if (!boundaryMatch) return null;
  const boundary = boundaryMatch[1].replace(/^["']|["']$/g, '').trim();
  if (!boundary) return null;

  const decodeBody = (body: string, encoding: string | null): string => {
    if (!encoding) return body;
    const enc = encoding.toLowerCase().trim();
    if (enc === 'base64') {
      try {
        const cleaned = body.replace(/\s/g, '');
        const binary = atob(cleaned);
        const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
        return new TextDecoder('utf-8').decode(bytes);
      } catch {
        return body;
      }
    }
    if (enc === 'quoted-printable' || enc === 'quotedprintable') {
      try {
        let decoded = body.replace(/=\r?\n/g, '');
        decoded = decoded.replace(/=([0-9A-F]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
        return decoded;
      } catch {
        return body;
      }
    }
    return body;
  };

  // 先收集所有 parts，抽 html/plain 及 inline 圖片（支援嵌套 multipart）
  const imageMap = new Map<string, string>(); // cid -> data URL
  let htmlBody: string | null = null;
  let plainBody: string | null = null;

  const processParts = (text: string, b: string) => {
    const rawParts = text.split(`--${b}`);
    for (const rawPart of rawParts) {
      const part = rawPart.trim();
      if (!part || part === '--' || part.startsWith('This is an OpenPGP')) continue;
      const headerEnd = part.search(/\r?\n\r?\n/);
      if (headerEnd === -1) continue;
      const headerBlock = part.substring(0, headerEnd);
      const bodyRaw = part.substring(headerEnd).replace(/^\r?\n\r?\n/, '').trim();
      if (!bodyRaw) continue;

      const ctMatch = headerBlock.match(/Content-Type:\s*([^\r\n;]+)(?:;[^\r\n]*)?/i);
      const contentType = ctMatch ? ctMatch[1].trim().toLowerCase() : '';
      const encMatch = headerBlock.match(/Content-Transfer-Encoding:\s*([^\r\n]+)/i);
      const encoding = encMatch ? encMatch[1].trim() : null;
      const cidMatch = headerBlock.match(/Content-ID:\s*<?([^>\r\n]+)>?/i);
      const cid = cidMatch ? cidMatch[1].trim().replace(/^<|>$/g, '') : null;

      // 若係嵌套 multipart，遞迴處理
      if (contentType.startsWith('multipart/')) {
        const innerBoundaryMatch = headerBlock.match(/boundary="([^"]+)"/i) || headerBlock.match(/boundary=([^\s;]+)/i);
        if (innerBoundaryMatch) {
          const innerBoundary = innerBoundaryMatch[1].replace(/^["']|["']$/g, '').trim();
          if (innerBoundary) {
            processParts(bodyRaw, innerBoundary);
            continue;
          }
        }
      }

      if (contentType.startsWith('image/')) {
        // inline 圖片：轉 data URL
        const b64 = bodyRaw.replace(/\s/g, '');
        const dataUrl = `data:${contentType};base64,${b64}`;
        if (cid) {
          imageMap.set(cid, dataUrl);
          imageMap.set(`<${cid}>`, dataUrl);
        }
        continue;
      }

      if (contentType === 'text/html' && !htmlBody) {
        htmlBody = decodeBody(bodyRaw, encoding);
        continue;
      }
      if (contentType === 'text/plain' && !plainBody) {
        plainBody = decodeBody(bodyRaw, encoding);
        continue;
      }
    }
  };

  processParts(mimeText, boundary);

  // Fallback：若未搵到，嘗試直接喺成個 MIME 掃描 image/*（處理非標準嵌套）
  if (imageMap.size === 0) {
    const imgRegex = /Content-Type:\s*(image\/[^\r\n;]+)[\s\S]*?Content-ID:\s*<?([^>\r\n]+)>?[\s\S]*?\r?\n\r?\n([\s\S]*?)(?=\r?\n--|\n--|\Z)/gi;
    let m: RegExpExecArray | null;
    while ((m = imgRegex.exec(mimeText)) !== null) {
      const ct = m[1].trim().toLowerCase();
      const cid = m[2].trim().replace(/^<|>$/g, '');
      const b64 = m[3].replace(/\s/g, '').trim();
      if (cid && b64 && !imageMap.has(cid)) {
        imageMap.set(cid, `data:${ct};base64,${b64}`);
      }
    }
  }

  // 若有 html，替換 cid: 為 data: 並回傳 html
  if (htmlBody) {
    let html = htmlBody;
    for (const [cid, dataUrl] of imageMap) {
      const cleanCid = cid.replace(/^<|>$/g, '');
      html = html.replace(new RegExp(`cid:${cleanCid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'gi'), dataUrl);
      html = html.replace(new RegExp(`cid:<${cleanCid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}>`, 'gi'), dataUrl);
    }
    return html;
  }
  if (plainBody) return plainBody;

  // Fallback：舊邏輯逐個 type 搜尋（兼容非標準分割）
  const tryExtract = (type: string): string | null => {
    const headerRegex = new RegExp(`Content-Type:\\s*${type}[^\\r\\n]*\\r?\\n`, 'gi');
    let m: RegExpExecArray | null;
    while ((m = headerRegex.exec(mimeText)) !== null) {
      const headerStart = m.index;
      let bodyStart = mimeText.indexOf('\r\n\r\n', headerStart);
      let sepLen = 4;
      if (bodyStart === -1) {
        bodyStart = mimeText.indexOf('\n\n', headerStart);
        sepLen = 2;
      }
      if (bodyStart === -1) continue;
      bodyStart += sepLen;
      let bodyEnd = mimeText.indexOf(`\r\n--${boundary}`, bodyStart);
      if (bodyEnd === -1) bodyEnd = mimeText.indexOf(`\n--${boundary}`, bodyStart);
      if (bodyEnd === -1) bodyEnd = mimeText.length;
      let body = mimeText.substring(bodyStart, bodyEnd).trim();
      if (!body) continue;
      const headerBlock = mimeText.substring(headerStart, bodyStart);
      const encMatch = headerBlock.match(/Content-Transfer-Encoding:\s*([^\r\n]+)/i);
      const encoding = encMatch ? encMatch[1].trim() : null;
      body = decodeBody(body, encoding);
      if (body) return body;
    }
    return null;
  };
  return tryExtract('text\\/html') || tryExtract('text\\/plain');
};

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
    let tmp = primaryUser;
    let prev: string;
    do {
      prev = tmp;
      tmp = tmp.replace(/<[^>]*>/g, '');
    } while (tmp !== prev);
    name = tmp.trim();
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

  // 3. 匯入既有的個人私鑰/金鑰對（可選 passphrase 驗證；若 key 有 passphrase 則必填）
  importPersonalKey: async (
    privateKeyArmored: string,
    publicKeyArmored?: string,
    passphrase?: string
  ): Promise<PgpKeyPair> => {
    const privKey = await openpgp.readPrivateKey({ armoredKey: privateKeyArmored });

    // 若私鑰有 passphrase 保護，立即驗證（確保 key 用得到）
    if (!privKey.isDecrypted()) {
      try {
        await openpgp.decryptKey({ privateKey: privKey, passphrase: passphrase || '' });
      } catch {
        throw new Error('私鑰密碼 (Passphrase) 錯誤，無法匯入。請輸入匯入時設定嘅護照密碼。');
      }
    }

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

    // 若解密後係完整 MIME（Thunderbird protected-headers="v1" / Roundcube Enigma 同款：解密後係 multipart/mixed），抽取內文
    // 對齊 RFC 3156 §4：解密後內層 MIME 需重建，再解析（Thunderbird RNP / Roundcube rcube_mime 都係咁做）
    if (/^Content-Type:\s*multipart\//im.test(cleanText) && /boundary=/i.test(cleanText)) {
      const extracted = extractTextFromMime(cleanText);
      if (extracted) {
        cleanText = extracted;
      }
    } else if (/^Content-Type:\s*text\//im.test(cleanText) && /Content-Transfer-Encoding:\s*base64/i.test(cleanText)) {
      // 單一部分 base64（非 multipart）→ 解碼
      const headerEnd = cleanText.search(/\r?\n\r?\n/);
      if (headerEnd !== -1) {
        let body = cleanText.substring(headerEnd).trim();
        try {
          const cleaned = body.replace(/\s/g, '');
          const decoded = new TextDecoder('utf-8').decode(Uint8Array.from(atob(cleaned), (c) => c.charCodeAt(0)));
          if (decoded && decoded.length > 10) {
            cleanText = decoded;
          }
        } catch {}
      }
    }

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

  // 輔助：從解密後嘅完整 MIME（multipart/mixed + protected-headers="v1"）抽取 text/plain 內文
  // 對齊 Thunderbird / Roundcube Enigma 解密後重建 MIME tree 嘅行為
  extractTextFromMime,

  isPgpSigned: (content: string): boolean => {
    return /-----BEGIN PGP SIGNED MESSAGE-----/i.test(content);
  },
};
