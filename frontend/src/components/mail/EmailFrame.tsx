import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import { ShieldAlert, Image, Lock, Unlock, ShieldCheck, Key } from 'lucide-react';
import { AttachmentInfo } from '../../types/api';
import { mailApi } from '../../api/mail';
import { pgpService } from '../../api/pgp';

interface EmailFrameProps {
  uid: number;
  folder: string;
  htmlBody: string;
  textBody: string;
  attachments: AttachmentInfo[];
  onDecryptedChange?: (text: string) => void;
  trustedSender?: boolean;
}

// 寬度自適應（fit-to-width）常量 — 見 MAIL-RENDER.md §4.1
const WIDTH_EPS = 40; // 只處理超出閱讀欄 40px 以上的闊郵件，避免臨界抖動
const WIDTH_MAX_FRAMES = 8; // 穩定量度最多等 ~8 個 rAF（image load / table reflow）
const WIDTH_MIN_SCALE = 0.45; // 縮放下限，再闊都用橫向捲動而非無限縮細

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

export const EmailFrame: React.FC<EmailFrameProps> = ({
  uid,
  folder,
  htmlBody,
  textBody,
  attachments,
  onDecryptedChange,
  trustedSender = false,
}) => {
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
      // pass 1：以欄寬渲染，量度內容溢出寬度（reflow-assist CSS 已收文可縮的 table/img）
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
      setDecryptError('請先在「PGP 金鑰設定」中生成或匯入你的私鑰');
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
      setDecryptError(err.message || '解密失敗，可能是 Passphrase 錯誤或非針對此金鑰加密');
    }
  };

  // 處理內嵌 CID 圖片與外部圖片攔截
  const processedHtml = useMemo(() => {
    // 若已解密，直接以解密後的純淨文字渲染，絕不顯示原始密文
    if (decryptedContent !== null) {
      const looksLikeHtml = /<\s*(html|body|div|p|img|a|h[1-6]|ul|ol|table|br)[^>]*>/i.test(decryptedContent);
      if (looksLikeHtml) {
        let htmlForSanitize = decryptedContent.replace(/<img[^>]*Template_Bilingual[^>]*>/gi, '');
        htmlForSanitize = htmlForSanitize.replace(/<img[^>]*width=["']?1["']?[^>]*height=["']?1["']?[^>]*>/gi, '');
        const clean = DOMPurify.sanitize(htmlForSanitize, {
          WHOLE_DOCUMENT: false,
          ADD_TAGS: ['style', 'iframe'],
          ADD_ATTR: ['target', 'data-blocked-src'],
          FORBID_TAGS: ['script', 'object', 'embed', 'applet'],
          FORBID_ATTR: ['onload', 'onerror', 'onclick', 'onmouseover'],
        });
        return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.6;color:#1e293b;margin:0;padding:16px;word-break:normal;overflow-wrap:break-word;width:100%;box-sizing:border-box}.email-content{max-width:720px;margin:0 auto}table{border-collapse:collapse;max-width:100% !important}div,td,th{max-width:100% !important}td,th{word-break:normal;vertical-align:top}img{max-width:100% !important;height:auto}img[data-blocked-src]{background:#f8fafc;border:1px dashed #cbd5e1;color:#94a3b8;font-size:12px;box-sizing:border-box}a{color:#2563eb}</style></head><body><div class="email-content">${clean}</div></body></html>`;
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

    let content = htmlBody;

    // 若無 HTML 則將純文字轉為換行 HTML
    if (!content && textBody) {
      const escaped = textBody
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\n/g, '<br/>');
      return `<div style="font-family: sans-serif; white-space: pre-wrap; line-height: 1.6; color: #1e293b; padding: 16px; box-sizing: border-box; max-width: 100%; overflow-wrap: break-word; word-break: break-word;">${escaped}</div>`;
    }

    if (!content) {
      return '<div style="color: #64748b; font-style: italic;">（此郵件無內文）</div>';
    }

    // 替換 cid: 圖片為後端暫時下載 URL
    attachments.forEach((att) => {
      if (att.contentId || att.id) {
        const targetId = att.contentId || att.id;
        const inlineUrl = mailApi.getAttachmentUrl(uid, targetId, folder);
        const cidRegex = new RegExp(`cid:${targetId}`, 'gi');
        content = content.replace(cidRegex, inlineUrl);
      }
    });

    // 隱藏無可救藥嘅破圖：Word 匯出嘅相對路徑佔位圖（Template_Bilingual...png）或其他相對路徑圖，
    // 喺 sandbox iframe 內永遠解析失敗 → 顯示破圖。凡 src 唔係 http/https/data/cid/absolute 都好一一移除。
    content = content.replace(
      /<img[^>]*\ssrc=["'](?!https?:|data:|cid:|about:|blob:|\/)[^"']+["'][^>]*>/gi,
      ''
    );

    // 偵測是否含有外部 http/https 圖片
    const hasExternal = /<img[^>]+src=["']https?:\/\//i.test(content);
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
          next = next.replace(/\s*\/?>$/, ' alt="[已阻擋外部圖片]">');
        }
        return next;
      });
    }

    // DOMPurify XSS 安全過濾
    const clean = DOMPurify.sanitize(content, {
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
            table { border-collapse: collapse; max-width: 100% !important; }
            div, td, th { max-width: 100% !important; }
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
        </head>
        <body>
          <div class="email-content">
          ${clean}
          </div>
        </body>
      </html>
    `;

    return wrapper;
  }, [htmlBody, textBody, decryptedContent, attachments, uid, folder, allowRemoteImages]);

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

  return (
    <div className="flex flex-col min-h-full w-full max-w-4xl mx-auto bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 overflow-hidden shadow-sm">
      {/* PGP 加密提示列 (未解密時) */}
      {isPgpMessage && !isDecrypted && (
        <div className="flex items-center justify-between px-4 py-2.5 bg-indigo-50 dark:bg-indigo-950/60 border-b border-indigo-200 dark:border-indigo-800/80 text-indigo-950 dark:text-indigo-200 text-xs">
          <div className="flex items-center gap-2">
            <Lock className="w-4 h-4 text-indigo-600 dark:text-indigo-400 shrink-0" />
            <span className="font-semibold">這是一封 PGP 端到端加密郵件</span>
          </div>
          <button
            onClick={() => {
              setShowPassModal(true);
              handleDecrypt();
            }}
            className="flex items-center gap-1.5 px-3 py-1 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg font-semibold transition shadow-sm"
          >
            <Unlock className="w-3.5 h-3.5" />
            立即解密
          </button>
        </div>
      )}

      {/* PGP 成功解密與簽名狀態條 */}
      {isDecrypted && (
        <div className="flex items-center justify-between px-4 py-2 bg-emerald-50 dark:bg-emerald-950/50 border-b border-emerald-200 dark:border-emerald-800/60 text-emerald-900 dark:text-emerald-200 text-xs">
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-emerald-600 shrink-0" />
            <span className="font-semibold">已完成 PGP 解密</span>
          </div>
          {isSignatureVerified !== null && (
            <span className={`px-2 py-0.5 rounded text-[11px] font-bold ${
              isSignatureVerified
                ? 'bg-emerald-600 text-white'
                : 'bg-slate-200 dark:bg-slate-800 text-slate-600 dark:text-slate-400'
            }`}>
              {isSignatureVerified
                ? `✅ 數位簽名已驗證 ${signatureKeyId ? `(${signatureKeyId})` : ''}`
                : '⚠️ 未簽名或未驗證簽名'}
            </span>
          )}
        </div>
      )}

      {/* 外部圖片安全提示欄 */}
      {hasRemoteImages && !allowRemoteImages && (
        <div className="flex items-center justify-between px-4 py-2 bg-amber-50 dark:bg-amber-950/40 border-b border-amber-200 dark:border-amber-800 text-amber-900 dark:text-amber-200 text-xs">
          <div className="flex items-center gap-2">
            <ShieldAlert className="w-4 h-4 text-amber-600 shrink-0" />
            <span>已攔截外部圖片連結以防追蹤像素。</span>
          </div>
          <button
            onClick={() => setUserAllowed(true)}
            className="flex items-center gap-1 px-2.5 py-1 bg-amber-600 hover:bg-amber-700 text-white rounded font-medium transition"
          >
            <Image className="w-3.5 h-3.5" />
            顯示圖片
          </button>
        </div>
      )}

      {/* 沙盒 Iframe (解密後僅渲染純淨明文)；闊郵件一律自動縮放至欄寬，用戶可用 pinch-zoom 看細節 */}
      <div
        ref={wrapRef}
        className="w-full"
        style={{
          height: Math.ceil(frameH * fitScale),
          // 正常 fit 後內容剛好等於欄寬（冇 scrollbars）；
          // 得尺超過縮放下限嘅極闊郵件先會橫向可拖
          overflowX: 'auto',
          WebkitOverflowScrolling: 'touch',
        }}
      >
        <iframe
          key={processedHtml}
          ref={iframeRef}
          onLoad={() => void measureDoc()}
          srcDoc={processedHtml}
          sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
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
              <span>輸入 PGP 私鑰密碼 (Passphrase)</span>
            </div>
            <p className="text-xs text-slate-500">
              請輸入你<b>生成/導入 PGP 金鑰時設定嘅 Passphrase</b>（唔係登入密碼）。
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
                placeholder="輸入 PGP 私鑰 Passphrase"
                className="w-full px-3 py-1.5 text-xs bg-slate-50 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg outline-none"
                autoFocus
              />
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowPassModal(false)}
                  className="px-3 py-1.5 text-xs text-slate-500 hover:bg-slate-100 rounded-lg"
                >
                  取消
                </button>
                <button
                  type="submit"
                  className="px-3 py-1.5 text-xs bg-blue-600 text-white rounded-lg font-semibold"
                >
                  確認解密
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
