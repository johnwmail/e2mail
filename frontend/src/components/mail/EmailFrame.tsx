import React, { useEffect, useMemo, useState } from 'react';
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
}

export const EmailFrame: React.FC<EmailFrameProps> = ({
  uid,
  folder,
  htmlBody,
  textBody,
  attachments,
  onDecryptedChange,
}) => {
  const [allowRemoteImages, setAllowRemoteImages] = useState(false);
  const [hasRemoteImages, setHasRemoteImages] = useState(false);

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
    setAllowRemoteImages(false);
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
        return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.6;color:#1e293b;margin:0;padding:16px;word-break:normal;overflow-wrap:break-word;overflow-x:auto;-webkit-overflow-scrolling:touch;width:100%;box-sizing:border-box}table{table-layout:auto;width:auto !important;min-width:0;max-width:none !important;border-collapse:collapse}td,th{word-break:normal;white-space:normal}img{max-width:100%;height:auto}img[data-blocked-src]{background:#f8fafc;color:#94a3b8;font-size:12px;box-sizing:border-box}img[src=""]{background:transparent}a{color:#2563eb}</style></head><body>${clean}</body></html>`;
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
            <style>
              body {
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
                font-size: 14px;
                line-height: 1.6;
                color: #1e293b;
                margin: 0;
                padding: 16px;
                word-break: break-word;
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
      return `<div style="font-family: sans-serif; white-space: pre-wrap; line-height: 1.6; color: #1e293b;">${escaped}</div>`;
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

    // 若未允許外部圖片，將 src 暫時阻擋為佔位（保留原圖 width/height 避免版面塌縮成窄 column）
    // 保留 width/height 令 email 原本嘅 602px 版面唔會因 header/footer 被 block 而塌縮
    if (!allowRemoteImages && hasExternal) {
      content = content.replace(
        /<img([^>]+)src=(["'])(https?:\/\/[^"']+)["']/gi,
        (match, attrs: string, quote: string, src: string) => {
          let width = '';
          let height = '';
          const wm = attrs.match(/\swidth=["']?(\d+)["']?/i);
          const hm = attrs.match(/\sheight=["']?(\d+)["']?/i);
          if (wm) width = wm[1];
          if (hm) height = hm[1];
          const dimStyle = [
            width ? `width:${width}px` : '',
            height ? `height:${height}px` : '',
          ].filter(Boolean).join(';');
          const placeholder =
            dimStyle ||
            'border:1px dashed #cbd5e1;padding:4px;background:#f8fafc;color:#94a3b8;font-size:12px;';
          return `<img${attrs}data-blocked-src=${quote}${src}${quote} src="" alt="[已阻擋外部圖片]" style="${placeholder};display:inline-block;vertical-align:middle;"${width ? ` width="${width}"` : ''}${height ? ` height="${height}"` : ''}>`;
        }
      );
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
          <style>
            body {
              font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
              font-size: 14px;
              line-height: 1.6;
              color: #1e293b;
              margin: 0;
              padding: 16px;
              word-break: normal;
              overflow-wrap: break-word;
              overflow-x: auto;
              -webkit-overflow-scrolling: touch;
              width: 100%;
              box-sizing: border-box;
            }
            table { table-layout: auto; width: auto !important; min-width: 0; max-width: none !important; border-collapse: collapse; }
            td, th { word-break: normal; white-space: normal; }
            img[data-blocked-src] { background: #f8fafc; color: #94a3b8; font-size: 12px; box-sizing: border-box; }
            img[src=""] { background: transparent; }
            img { max-width: 100%; height: auto; }
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
          ${clean}
        </body>
      </html>
    `;

    return wrapper;
  }, [htmlBody, textBody, decryptedContent, attachments, uid, folder, allowRemoteImages]);

  return (
    <div className="flex flex-col h-full w-full max-w-4xl mx-auto bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 overflow-hidden shadow-sm">
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
            onClick={() => setAllowRemoteImages(true)}
            className="flex items-center gap-1 px-2.5 py-1 bg-amber-600 hover:bg-amber-700 text-white rounded font-medium transition"
          >
            <Image className="w-3.5 h-3.5" />
            顯示圖片
          </button>
        </div>
      )}

      {/* 沙盒 Iframe (解密後僅渲染純淨明文) */}
      <iframe
        srcDoc={processedHtml}
        sandbox="allow-popups allow-popups-to-escape-sandbox"
        className="w-full flex-1 border-0"
        title="Email Body View"
      />

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
