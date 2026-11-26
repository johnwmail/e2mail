import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import { ShieldAlert, Image, Lock, Unlock, ShieldCheck, Key } from 'lucide-react';
import { AttachmentInfo } from '../../types/api';
import { mailApi } from '../../api/mail';
import { pgpService } from '../../api/pgp';
import { useI18n } from '../../i18n';

interface EmailFrameProps {
  uid: number;
  folder: string;
  htmlBody: string;
  textBody: string;
  attachments: AttachmentInfo[];
  onDecryptedChange?: (text: string) => void;
  trustedSender?: boolean;
}

// 寬度自適應（fit-to-width）常量 — 見 docs/MAIL-RENDER.md §4.1
const WIDTH_EPS = 40; // 只處理超出閱讀欄 40px 以上的闊郵件，避免臨界抖動
const WIDTH_MAX_FRAMES = 8; // 穩定量度最多等 ~8 個 rAF（image load / table reflow）
const WIDTH_MIN_SCALE = 0.45; // 縮放下限，再闊都用橫向捲動而非無限縮細

// 郵件 iframe 內部 CSP：最後防線，連 SVG <image href>、<video poster>、
// inline style url() 等唔經 <img> 嘅遠端載入都會被擋。預設只允許同源附件、
// data/blob 同 inline style；用戶按「顯示圖片」後才放寬 https 遠端資源。
const emailCspMeta = (allowRemote: boolean): string => {
  const remote = allowRemote ? ' https:' : '';
  return `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' data: blob:${remote}; media-src 'self' data: blob:${remote}; style-src 'unsafe-inline'; font-src data:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'">`;
};

// 偵測任何會自動載入遠端資源的屬性（<img> 以外仲有 SVG/video/table/inline CSS）。
// <a href> 唔計，因為連結要用戶點擊才會載入。
const hasRemoteResources = (html: string): boolean =>
  /<(?:img|image|video|audio|source|input|table|thead|tbody|tfoot|tr|td|th|body|svg)\b[^>]*(?:src|srcset|poster|background|href|xlink:href)\s*=\s*["']?\s*https?:/i.test(html) ||
  /style\s*=\s*["'][^"']*url\(\s*['"]?\s*https?:/i.test(html);

// 只限安全 raster image；同後端 inline 白名單一致。
const SAFE_INLINE_IMAGE = /^image\/(?:png|jpe?g|gif|webp|bmp|avif|x-icon|vnd\.microsoft\.icon)$/i;

const escapeAttr = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

export const computeFitScale = (paneW: number, intrinsicW: number): number => {
  if (paneW <= 0 || intrinsicW <= 0) return 1;
  const s = paneW / intrinsicW;
  return Math.min(1, Math.max(s, WIDTH_MIN_SCALE));
};

// iframe 以 W 寬 render 後輪候 layout 穩定（異步入圖、table reflow），先回報最終尺寸
const measureStable = (root: HTMLElement): Promise<{ w: number; h: number }> =>
  new Promise((resolve) => {
    let best = { w: root.scrollWidth, h: root.scrollHeight };
    let same = 0;
    let frames = 0;
    const step = () => {
      const cur = { w: root.scrollWidth, h: root.scrollHeight };
      if (cur.w === best.w && cur.h === best.h) {
        if (++same >= 2) {
          resolve(best);
          return;
        }
      } else {
        same = 0;
        best = cur;
      }
      if (++frames >= WIDTH_MAX_FRAMES) {
        resolve(best);
        return;
      }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });

// DOMPurify 喺 fragment mode（WHOLE_DOCUMENT:false）會剷走所有 <style> tag，
// 而 email 佈局（eMPF 嗰類 border / min-width 欄寬 class）全靠佢哋 → 必須喺
// sanitize 前提取出来，再注入返去 srcDoc head（排喺我哋 own CSS 之後）。
// CodeQL js/incomplete-multi-character-sanitization #9：單次 replace(/<style...>/g,"")
// 可被 "<sty<style>le>" 呢類嵌套繞過，必須循環至穩定；css 注入前亦需阻斷 </style> breakout。
const extractMailStyles = (html: string): { css: string; rest: string } => {
  const blocks: string[] = [];
  let rest = html;
  let prev: string;
  do {
    prev = rest;
    rest = rest.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, (m) => {
      const inner = m
        .replace(/^<style\b[^>]*>/i, '')
        .replace(/<\/style>\s*$/i, '')
        .replace(/@import[^;}]*;?/gi, '') // 外部 CSS = 追蹤 vector
        .replace(/url\(\s*['"]?https?:[^)'"]*['"]?\s*\)/gi, 'none') // CSS 內遠端圖/font
        .replace(/expression\s*\(/gi, 'expr(') // legacy IE script vector
        .slice(0, 60000);
      if (inner.trim()) blocks.push(inner);
      return '';
    });
  } while (rest !== prev);

  // 防止透過 CSS 內容 breakout 再注入 HTML（例如 "}</style><script>…"）
  let css = blocks.join('\n');
  let prevCss: string;
  do {
    prevCss = css;
    css = css.replace(/<\/style/gi, '');
  } while (css !== prevCss);
  do {
    prevCss = css;
    css = css.replace(/<style/gi, '');
  } while (css !== prevCss);
  css = css.slice(0, 60000);
  return { css, rest };
};

// 郵件內所有連結強制新分頁（http/https/其他一般 URL）；mailto:/tel: 交返俾系統處理。
// 亦會移除 target=_top/_parent/self 等企圖喺 app 內開啟嘅 target。
const forceNewTabLinks = (html: string): string =>
  html.replace(/<a\b([^>]*)>/gi, (match, attrs: string) => {
    const hrefM =
      attrs.match(/\shref=(["'])([^"']*)\1/i) ?? attrs.match(/\shref=([^\s"'>]+)/i);
    if (!hrefM) return match;
    const href = hrefM[2] ?? hrefM[1] ?? '';
    const stripTarget = (a: string) =>
      a.replace(/\s+target=(?:"[^"]*"|'[^']*'|[^\s"'>]+)/gi, '');
    if (/^(mailto:|tel:|sms:|callto:|xmpp:)/i.test(href)) {
      return /\starget=/i.test(attrs) ? `<a${stripTarget(attrs)}>` : match;
    }
    const base = stripTarget(attrs).replace(/\s+rel=(?:"[^"]*"|'[^']*'|[^\s"'>]+)/gi, '');
    return `<a${base} target="_blank" rel="noopener noreferrer">`;
  });

export const EmailFrame: React.FC<EmailFrameProps> = ({
  uid,
  folder,
  htmlBody,
  textBody,
  attachments,
  onDecryptedChange,
  trustedSender = false,
}) => {
  const { t } = useI18n();
  const [userAllowed, setUserAllowed] = useState(false);
  const [hasRemoteImages, setHasRemoteImages] = useState(false);
  // 可信寄件人（已在通訊錄）自動放行，無需 relogin
  const allowRemoteImages = trustedSender || userAllowed;

  // ── 闊版郵件 fit-to-width 量度（無 script，純 parent 側 DOM 量度）──
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const childRORef = useRef<ResizeObserver | null>(null);
  const childRODocRef = useRef<Document | null>(null);
  const [paneW, setPaneW] = useState(0);
  const [intrinsicW, setIntrinsicW] = useState(0);
  const [contentH, setContentH] = useState(0);

  const measuringRef = useRef(false);
  // RO 經 ref間接呼叫最新 measureDoc，避開 useCallback 循環依賴
  const measureDocRef = useRef<() => void>(() => {});

  const ensureChildObserver = useCallback((doc: Document, root: HTMLElement) => {
    if (typeof ResizeObserver === 'undefined' || childRODocRef.current === doc) return;
    childRORef.current?.disconnect();
    const ro = new ResizeObserver(() => void measureDocRef.current());
    ro.observe(root);
    if (doc.body) ro.observe(doc.body);
    childRORef.current = ro;
    childRODocRef.current = doc;
  }, []);

  const measureDoc = useCallback(async () => {
    if (measuringRef.current) return; // 防止 RO 喺 width pass1→2 中途重入
    const fr = iframeRef.current;
    const wrapEl = wrapRef.current;
    const doc = fr?.contentDocument;
    const root = doc?.documentElement;
    if (!fr || !wrapEl || !doc || !root) return;
    if (doc.readyState !== 'complete') return; // srcdoc 未 load 完，等 onLoad
    const pw = wrapEl.clientWidth;
    if (!pw) return; // jsdom / 隱藏中，跳過量度

    measuringRef.current = true;
    try {
      // 先喺 100% 欄寬渲染；若 .email-content (720 閱讀寬上限) 裝唔住內容（例如 eMPF
      // 呢類 794px 固定欄 + min-width 設計），解除上限 preserve 原設計，等 baseW 量到真正闊度
      const ec = doc.querySelector<HTMLElement>('.email-content');
      // 單向切換（''→'none'，不會倒轉）：判斷條件本身受 max-width 影響，
      // 解除上限後內容就「裝得落」，若再倒轉回 720，下一輪又超出 → 無限來回切換
      // （寬 pane 下每 ~40ms 一次，內容橫向跳動 = 閃爍）。iframe 每封郵件重建，狀態自然重置。
      if (ec && ec.style.maxWidth !== 'none' && ec.scrollWidth > ec.clientWidth + 8) {
        ec.style.maxWidth = 'none';
      }
      // pass 1：以欄寬渲染，量度內容溢出寬度（table/img 嘅自然溢出，唔好 clamp，
      // 否則固定欄位會被壓扁成窄欄，measure 唔到設計寬度）
      fr.style.width = '100%';
      const baseW = Math.max(root.scrollWidth, doc.body?.scrollWidth ?? 0);
      if (baseW <= pw + WIDTH_EPS) {
        if (doc.body) doc.body.style.width = '';
        setIntrinsicW(pw);
        setContentH(Math.max(root.scrollHeight, 160));
        ensureChildObserver(doc, root);
        return;
      }

      // pass 2：以設計寬度 W 重新排版，輪候穩定後攞最終內容高度
      fr.style.width = `${baseW}px`;
      const { w, h } = await measureStable(root);
      if (doc.body) doc.body.style.width = `${w}px`;
      setIntrinsicW(w);
      setContentH(Math.max(h, 160));
      ensureChildObserver(doc, root);
    } finally {
      measuringRef.current = false;
    }
  }, [ensureChildObserver]);

  measureDocRef.current = () => void measureDoc();

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    setPaneW(el.clientWidth);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const w = Math.round(entries[0].contentRect.width);
      setPaneW((prev) => (Math.abs(prev - w) > 1 ? w : prev));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(
    () => () => {
      childRORef.current?.disconnect();
      childRORef.current = null;
      childRODocRef.current = null;
    },
    [],
  );

  // PGP 解密狀態
  const [decryptedContent, setDecryptedContent] = useState<string | null>(null);
  const [isDecrypted, setIsDecrypted] = useState(false);
  const [isSignatureVerified, setIsSignatureVerified] = useState<boolean | null>(null);
  const [signatureKeyId, setSignatureKeyId] = useState<string | null>(null);
  const [passphrase, setPassphrase] = useState('');
  const [decryptError, setDecryptError] = useState<string | null>(null);
  const [showPassModal, setShowPassModal] = useState(false);

  const isPgpMessage = useMemo(() => {
    const raw = textBody || htmlBody || '';
    return pgpService.isPgpEncrypted(raw);
  }, [textBody, htmlBody]);

  useEffect(() => {
    setUserAllowed(false);
    setIntrinsicW(0);
    setContentH(0);
    setDecryptedContent(null);
    setIsDecrypted(false);
    setIsSignatureVerified(null);
    setSignatureKeyId(null);
    setDecryptError(null);
  }, [uid]);

  const handleDecrypt = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const keyPair = await pgpService.ensureKey();
    if (!keyPair) {
      setDecryptError(t('emailFrame.needPrivateKey'));
      return;
    }

    setDecryptError(null);
    // 若私鑰受 passphrase 保護而用戶未輸入，先提示輸入（唔直接報「密碼錯誤」）
    if (!passphrase) {
      const encrypted = await pgpService.isPrivateKeyEncrypted(keyPair.privateKeyArmored).catch(() => false);
      if (encrypted) {
        setShowPassModal(true);
        setDecryptError(null);
        return;
      }
    }
    try {
      const raw = textBody || htmlBody || '';
      const { data: cleanDecryptedText, verified, signatureKeyId: keyId } = await pgpService.decrypt({
        armoredMessage: raw,
        privateKeyArmored: keyPair.privateKeyArmored,
        passphrase,
      });

      setDecryptedContent(cleanDecryptedText);
      setIsDecrypted(true);
      setIsSignatureVerified(verified);
      setSignatureKeyId(keyId || null);
      setShowPassModal(false);
      // 通知外層 viewer 已解密，reply/forward 可用明文 quote
      onDecryptedChange?.(cleanDecryptedText);
    } catch (err: any) {
      setDecryptError(err.message || t('emailFrame.decryptFailed'));
    }
  };

  // Apple Mail（同部分手機客戶端）寄「只有相片」嘅郵件時，會用 multipart/mixed
  // 包住一個空白 text/plain 同一個 Content-Disposition: inline 嘅圖片，但冇
  // Content-ID、亦冇 HTML body。呢類圖片唔會喺 text body 出現，附件列又會過濾
  // inline parts，結果成封郵件空白。冇 HTML body 時直接喺內文顯示呢啲圖片。
  const orphanInlineImages = useMemo(() => {
    if (htmlBody.trim()) return [];
    return (attachments ?? []).filter(
      (att) => att.isInline && SAFE_INLINE_IMAGE.test(att.contentType),
    );
  }, [htmlBody, attachments]);

  // 處理內嵌 CID 圖片與外部圖片攔截
  const processedHtml = useMemo(() => {
    // 若已解密，直接以解密後的純淨文字渲染，絕不顯示原始密文
    if (decryptedContent !== null) {
      const looksLikeHtml = /<\s*(html|body|div|p|img|a|h[1-6]|ul|ol|table|br)[^>]*>/i.test(decryptedContent);
      if (looksLikeHtml) {
        let htmlForSanitize = decryptedContent.replace(/<img[^>]*Template_Bilingual[^>]*>/gi, '');
        htmlForSanitize = htmlForSanitize.replace(/<img[^>]*width=["']?1["']?[^>]*height=["']?1["']?[^>]*>/gi, '');
        setHasRemoteImages(hasRemoteResources(htmlForSanitize));
        const { css: mailCss, rest: bodyHtml } = extractMailStyles(htmlForSanitize);
        const clean = DOMPurify.sanitize(bodyHtml, {
          WHOLE_DOCUMENT: false,
          ADD_TAGS: ['style', 'iframe'],
          ADD_ATTR: ['target', 'data-blocked-src'],
          FORBID_TAGS: ['script', 'object', 'embed', 'applet'],
          FORBID_ATTR: ['onload', 'onerror', 'onclick', 'onmouseover'],
        });
        return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${emailCspMeta(allowRemoteImages)}<style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.6;color:#1e293b;margin:0;padding:16px;word-break:normal;overflow-wrap:break-word;width:100%;box-sizing:border-box}.email-content{max-width:720px;margin:0 auto}table{border-collapse:collapse}td,th{word-break:normal;vertical-align:top}.email-content{max-width:720px;margin:0 auto}img{max-width:100% !important;height:auto}img[data-blocked-src]{background:#f8fafc;border:1px dashed #cbd5e1;color:#94a3b8;font-size:12px;box-sizing:border-box}a{color:#2563eb}</style>${mailCss ? `<style>${mailCss}</style>` : ''}</head><body><div class="email-content">${forceNewTabLinks(clean)}</div></body></html>`;
      }
      let escaped = decryptedContent
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
      // 將裸 URL 轉為可點擊連結，處理 jobsdb 追蹤連結被 format=flowed 斷行（-\n）同括號包裹嘅情況
      // 先處理括號內嘅 URL（[https://...]，可能含換行同連接符）
      escaped = escaped.replace(/\[(https?:\/\/[\s\S]*?)\]/gi, (_m, urlContent: string) => {
        const cleanUrl = urlContent.replace(/-\r?\n/g, '').replace(/\s/g, '').trim();
        if (/^https?:\/\//i.test(cleanUrl)) {
          const safeUrl = cleanUrl.replace(/"/g, '&quot;');
          return `[<a href="${safeUrl}" target="_blank" rel="noopener noreferrer" style="color:#2563eb;text-decoration:underline;word-break:break-all;">${safeUrl}</a>]`;
        }
        return _m;
      });
      // 再處理裸露 URL（非括號，非已係 <a>）
      escaped = escaped.replace(/(https?:\/\/[^\s<\]\)"']+)/gi, (url) => {
        // 清理因換行導致嘅斷裂（雖然裸露 URL 較少斷行，但仍處理）
        const cleanUrl = url.replace(/-\r?\n/g, '').trim();
        if (cleanUrl.length < 10) return url;
        const safeUrl = cleanUrl.replace(/"/g, '&quot;');
        // 避免重複包裹已在 <a> 入面嘅
        if (escaped.includes(`href="${safeUrl}"`)) return url;
        return `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer" style="color:#2563eb;text-decoration:underline;word-break:break-all;">${safeUrl}</a>`;
      });
      escaped = escaped.replace(/\n/g, '<br/>');
      return `
        <!DOCTYPE html>
        <html>
          <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1">
            ${emailCspMeta(allowRemoteImages)}
            <style>
              body {
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
                font-size: 14px;
                line-height: 1.6;
                color: #1e293b;
                margin: 0;
                padding: 16px;
                word-break: break-word;
                overflow-wrap: break-word;
                white-space: pre-wrap;
              }
            </style>
          </head>
          <body>${escaped}</body>
        </html>
      `;
    }

    let content = htmlBody.trim() ? htmlBody : '';

    // 若無 HTML 則將純文字轉為換行 HTML；同時補上冇被任何地方引用嘅 inline 圖片
    // （典型例子：iPhone 寄一張相，text/plain 空白、圖片冇 Content-ID）。
    if (!content) {
      const hasText = textBody.trim().length > 0;
      const imagesHtml = orphanInlineImages
        .map((att) => {
          const src = att.inlineData || mailApi.getAttachmentUrl(uid, att.id, folder);
          return `<img src="${escapeAttr(src)}" alt="${escapeAttr(att.filename || '')}" style="display:block;max-width:100%;height:auto;margin:12px 0;" />`;
        })
        .join('');

      if (!hasText && !imagesHtml) {
        return `<div style="color: #64748b; font-style: italic;">${t('emailFrame.emptyBody')}</div>`;
      }

      const escaped = hasText
        ? textBody
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/\n/g, '<br/>')
        : '';
      return `<div style="font-family: sans-serif; white-space: pre-wrap; line-height: 1.6; color: #1e293b; padding: 16px; box-sizing: border-box; max-width: 100%; overflow-wrap: break-word; word-break: break-word;">${escaped}${imagesHtml}</div>`;
    }

    // 替換 cid: 圖片為後端暫時下載 URL。
    // 必須匹配完整 cid token，否則 `cc_hk_blank` 會錯誤匹配 `cc_hk_blank1` 前綴。
    content = content.replace(/cid:([^\s"'<>]+)/gi, (match, cid: string) => {
      const wanted = cid.toLowerCase();
      const att =
        attachments.find((a) => a.contentId?.toLowerCase() === wanted) ??
        attachments.find((a) => a.filename?.toLowerCase() === wanted);
      if (!att) return match;
      return att.inlineData || mailApi.getAttachmentUrl(uid, att.id, folder);
    });

    // 部分 HTML mail（例如 SC eStatement）用相對路徑引用 inline 圖片：
    //   <img src="blank.gif"> / <img src=logo-CN_03.gif>
    // iframe 內相對路徑會解析成 app origin → 404 破圖。優先用附件
    // filename / Content-ID 對應返後端附件 URL；對應唔到才移除。
    const attachmentsByName = new Map<string, AttachmentInfo>();
    for (const att of attachments) {
      for (const key of [att.filename, att.contentId]) {
        if (!key) continue;
        const lower = key.toLowerCase();
        attachmentsByName.set(lower, att);
        const base = lower.split(/[\\/]/).pop();
        if (base && base !== lower) attachmentsByName.set(base, att);
      }
    }
    const safeInlineImage = /^image\/(?:png|jpe?g|gif|webp|bmp|avif|x-icon|vnd\.microsoft\.icon)$/i;
    content = content.replace(/<img\b[^>]*>/gi, (tag) => {
      const srcMatch = tag.match(/\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i);
      if (!srcMatch) return tag;
      const rawSrc = (srcMatch[1] ?? srcMatch[2] ?? srcMatch[3] ?? '').trim();
      if (!rawSrc) return tag;

      // 遠端、data、blob、absolute path 已由其他邏輯處理。
      if (/^(?:https?:|data:|about:|blob:|\/|#)/i.test(rawSrc)) return tag;

      let decoded = rawSrc;
      try {
        decoded = decodeURIComponent(rawSrc);
      } catch {
        // keep original
      }
      const base = (decoded.split(/[\\/]/).pop() ?? decoded).split(/[?#]/)[0];
      const candidates = [decoded, base];
      if (/^cid:/i.test(decoded)) {
        const cidName = decoded.slice(4);
        candidates.push(cidName, (cidName.split(/[\\/]/).pop() ?? cidName).split(/[?#]/)[0]);
      }

      let att: AttachmentInfo | undefined;
      for (const key of candidates) {
        att = attachmentsByName.get(key.toLowerCase());
        if (att) break;
      }
      // 只對安全 raster image 做 inline；SVG/HTML/PDF 一律移除（後端亦強制 attachment）。
      if (!att || !safeInlineImage.test(att.contentType)) return '';

      const url = att.inlineData || mailApi.getAttachmentUrl(uid, att.id, folder);
      return tag.replace(srcMatch[0], ` src="${url}"`);
    });

    // 偵測是否含有任何會自動載入的遠端資源（img / SVG / video / table background / inline CSS）
    const hasExternal = hasRemoteResources(content);
    setHasRemoteImages(hasExternal);

    // 若未允許外部圖片，只改寫 src 屬性、保留原圖所有屬性（含 width/height），
    // 佔位框由 CSS img[data-blocked-src] 提供；闊度由 img{max-width:100%!important} 兜底，
    // 避免 600px+ 佔位圖喺手機上撐出空白右側。
    if (!allowRemoteImages && hasExternal) {
      content = content.replace(/<img\b[^>]*>/gi, (tag) => {
        if (!/\ssrc=["']https?:\/\//i.test(tag)) return tag;
        let next = tag.replace(
          /\ssrc=(["'])(https?:\/\/[^"']+)\1/i,
          (_m, _q: string, url: string) => ` data-blocked-src="${url.replace(/"/g, '&quot;')}" src=""`,
        );
        if (!/\salt=/i.test(next)) {
          next = next.replace(/\s*\/?>$/, ` alt="${t('emailFrame.blockedImage')}">`);
        }
        return next;
      });
    }

    // 提取 email 自己嘅 <style>（DOMPurify fragment mode 會剷走哋）
    const { css: mailCss, rest: contentNoStyles } = extractMailStyles(content);

    // DOMPurify XSS 安全過濾
    const clean = DOMPurify.sanitize(contentNoStyles, {
      WHOLE_DOCUMENT: false,
      ADD_TAGS: ['style', 'iframe'],
      ADD_ATTR: ['target', 'data-blocked-src'],
      FORBID_TAGS: ['script', 'object', 'embed', 'applet'],
      FORBID_ATTR: ['onload', 'onerror', 'onclick', 'onmouseover'],
    });

    const wrapper = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1">
          ${emailCspMeta(allowRemoteImages)}
          <style>
            html, body { max-width: 100%; }
            body {
              font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
              font-size: 14px;
              line-height: 1.6;
              color: #1e293b;
              margin: 0;
              padding: 16px;
              word-break: normal;
              overflow-wrap: break-word;
              width: 100%;
              box-sizing: border-box;
            }
            table { border-collapse: collapse; }
            td, th { word-break: normal; vertical-align: top; }
            .email-content { max-width: 720px; margin: 0 auto; }
            img[data-blocked-src] { background: #f8fafc; border: 1px dashed #cbd5e1; color: #94a3b8; font-size: 12px; box-sizing: border-box; }
            img { max-width: 100% !important; height: auto; }
            a { color: #2563eb; text-decoration: underline; }
            blockquote {
              border-left: 3px solid #cbd5e1;
              margin-left: 0;
              padding-left: 12px;
              color: #64748b;
            }
          </style>
          ${mailCss ? `<style>${mailCss}</style>` : ''}
        </head>
        <body>
          <div class="email-content">
          ${forceNewTabLinks(clean)}
          </div>
        </body>
      </html>
    `;

    return wrapper;
  }, [htmlBody, textBody, decryptedContent, attachments, uid, folder, allowRemoteImages, orphanInlineImages, t]);

  // srcDoc 重組（換信 / 放行圖片 / 解密）→ 作廢舊量度，load 後重新計
  useEffect(() => {
    setIntrinsicW(0);
    setContentH(0);
  }, [processedHtml]);

  useEffect(() => {
    void measureDoc();
  }, [processedHtml, paneW, measureDoc]);

  const isWideEmail = intrinsicW > 0 && paneW > 0 && intrinsicW > paneW + WIDTH_EPS;
  const fitScale = isWideEmail ? computeFitScale(paneW, intrinsicW) : 1;
  const frameH = Math.max(contentH, 320);
  // wrapper 高度已跟內容算好，唔需要垂直捲動；而 overflow-x:auto 會令 overflow-y
  // 一併變 auto，縮放後 1px 級捨入誤差就會彈出一對捲軸（桌面約 15px），
  // 食咗闊度再令縮放比例改變。只有縮到下限仍然超闊先容許橫向捲動。
  const needsHScroll = isWideEmail && intrinsicW * fitScale > paneW + 1;

  return (
    <div className="flex flex-col min-h-full w-full max-w-4xl mx-auto bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 overflow-hidden shadow-sm">
      {/* PGP 加密提示列 (未解密時) */}
      {isPgpMessage && !isDecrypted && (
        <div className="flex items-center justify-between px-4 py-2.5 bg-indigo-50 dark:bg-indigo-950/60 border-b border-indigo-200 dark:border-indigo-800/80 text-indigo-950 dark:text-indigo-200 text-xs">
          <div className="flex items-center gap-2">
            <Lock className="w-4 h-4 text-indigo-600 dark:text-indigo-400 shrink-0" />
            <span className="font-semibold">{t('emailFrame.encryptedBanner')}</span>
          </div>
          <button
            onClick={() => {
              setShowPassModal(true);
              handleDecrypt();
            }}
            className="flex items-center gap-1.5 px-3 py-1 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg font-semibold transition shadow-sm"
          >
            <Unlock className="w-3.5 h-3.5" />
            {t('emailFrame.decryptNow')}
          </button>
        </div>
      )}

      {/* PGP 成功解密與簽名狀態條 */}
      {isDecrypted && (
        <div className="flex items-center justify-between px-4 py-2 bg-emerald-50 dark:bg-emerald-950/50 border-b border-emerald-200 dark:border-emerald-800/60 text-emerald-900 dark:text-emerald-200 text-xs">
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-emerald-600 shrink-0" />
            <span className="font-semibold">{t('emailFrame.decrypted')}</span>
          </div>
          {isSignatureVerified !== null && (
            <span className={`px-2 py-0.5 rounded text-[11px] font-bold ${
              isSignatureVerified
                ? 'bg-emerald-600 text-white'
                : 'bg-slate-200 dark:bg-slate-800 text-slate-600 dark:text-slate-400'
            }`}>
              {isSignatureVerified
                ? t('emailFrame.sigOk', { keyId: signatureKeyId ? `(${signatureKeyId})` : '' })
                : t('emailFrame.sigMissing')}
            </span>
          )}
        </div>
      )}

      {/* 外部圖片安全提示欄 */}
      {hasRemoteImages && !allowRemoteImages && (
        <div className="flex items-center justify-between px-4 py-2 bg-amber-50 dark:bg-amber-950/40 border-b border-amber-200 dark:border-amber-800 text-amber-900 dark:text-amber-200 text-xs">
          <div className="flex items-center gap-2">
            <ShieldAlert className="w-4 h-4 text-amber-600 shrink-0" />
            <span>{t('emailFrame.trackingBlocked')}</span>
          </div>
          <button
            onClick={() => setUserAllowed(true)}
            className="flex items-center gap-1 px-2.5 py-1 bg-amber-600 hover:bg-amber-700 text-white rounded font-medium transition"
          >
            <Image className="w-3.5 h-3.5" />
            {t('emailFrame.showImages')}
          </button>
        </div>
      )}

      {/* 沙盒 Iframe (解密後僅渲染純淨明文)；闊郵件一律自動縮放至欄寬，用戶可用 pinch-zoom 看細節 */}
      <div
        ref={wrapRef}
        className="w-full"
        style={{
          height: Math.ceil(frameH * fitScale) + (needsHScroll ? 16 : 0),
          // 正常 fit 後內容剛好等於欄寬（冇 scrollbars）；
          // 得尺超過縮放下限嘅極闊郵件先會橫向可拖
          overflowX: needsHScroll ? 'auto' : 'hidden',
          overflowY: 'hidden',
          WebkitOverflowScrolling: 'touch',
        }}
      >
        <iframe
          key={processedHtml}
          ref={iframeRef}
          onLoad={() => void measureDoc()}
          srcDoc={processedHtml}
          sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
          referrerPolicy="no-referrer"
          className="border-0 block"
          style={{
            width: '100%',
            height: `${frameH}px`,
            transform: fitScale < 1 ? `scale(${fitScale})` : undefined,
            transformOrigin: '0 0',
            background: 'transparent',
          }}
          title="Email Body View"
        />
      </div>

      {/* PGP Passphrase 輸入彈窗 */}
      {showPassModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm">
          <div className="w-full max-w-sm bg-white dark:bg-slate-900 rounded-xl p-5 shadow-2xl border border-slate-200 dark:border-slate-800 space-y-4">
            <div className="flex items-center gap-2 font-bold text-sm text-slate-900 dark:text-white">
              <Key className="w-4 h-4 text-blue-600" />
              <span>{t('emailFrame.passphraseTitle')}</span>
            </div>
            <p className="text-xs text-slate-500">
              {t('emailFrame.passphraseHint')}
            </p>

            {decryptError && (
              <div className="p-2 text-xs bg-red-50 text-red-700 border border-red-200 rounded">
                {decryptError}
              </div>
            )}

            <form onSubmit={handleDecrypt} className="space-y-3">
              <input
                type="password"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                placeholder={t('emailFrame.passphrasePlaceholder')}
                className="w-full px-3 py-1.5 text-xs bg-slate-50 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg outline-none"
                autoFocus
              />
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowPassModal(false)}
                  className="px-3 py-1.5 text-xs text-slate-500 hover:bg-slate-100 rounded-lg"
                >
                  {t('common.cancel')}
                </button>
                <button
                  type="submit"
                  className="px-3 py-1.5 text-xs bg-blue-600 text-white rounded-lg font-semibold"
                >
                  {t('emailFrame.confirmDecrypt')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
