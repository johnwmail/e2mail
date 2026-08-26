import React, { useState, useEffect } from 'react';
import { Mail, Lock, Eye, EyeOff, ChevronDown, ChevronUp, Loader2, AlertCircle, ShieldAlert, Sparkles, Server, KeyRound, ArrowLeft } from 'lucide-react';
import { useAuthStore } from '../../stores/useAuthStore';

interface ServerDefaults {
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
  allowInsecureTls: boolean;
}

const KNOWN_DOMAINS: Record<string, { imapHost: string; imapPort: number; smtpHost: string; smtpPort: number; allowInsecure?: boolean }> = {
  'gmail.com': { imapHost: 'imap.gmail.com', imapPort: 993, smtpHost: 'smtp.gmail.com', smtpPort: 587, allowInsecure: false },
  'googlemail.com': { imapHost: 'imap.gmail.com', imapPort: 993, smtpHost: 'smtp.gmail.com', smtpPort: 587, allowInsecure: false },
  'outlook.com': { imapHost: 'outlook.office365.com', imapPort: 993, smtpHost: 'smtp.office365.com', smtpPort: 587, allowInsecure: false },
  'hotmail.com': { imapHost: 'outlook.office365.com', imapPort: 993, smtpHost: 'smtp.office365.com', smtpPort: 587, allowInsecure: false },
  'live.com': { imapHost: 'outlook.office365.com', imapPort: 993, smtpHost: 'smtp.office365.com', smtpPort: 587, allowInsecure: false },
  'office365.com': { imapHost: 'outlook.office365.com', imapPort: 993, smtpHost: 'smtp.office365.com', smtpPort: 587, allowInsecure: false },
  'yahoo.com': { imapHost: 'imap.mail.yahoo.com', imapPort: 993, smtpHost: 'smtp.mail.yahoo.com', smtpPort: 587, allowInsecure: false },
  'yahoo.com.hk': { imapHost: 'imap.mail.yahoo.com', imapPort: 993, smtpHost: 'smtp.mail.yahoo.com', smtpPort: 587, allowInsecure: false },
  'icloud.com': { imapHost: 'imap.mail.me.com', imapPort: 993, smtpHost: 'smtp.mail.me.com', smtpPort: 587, allowInsecure: false },
  'me.com': { imapHost: 'imap.mail.me.com', imapPort: 993, smtpHost: 'smtp.mail.me.com', smtpPort: 587, allowInsecure: false },
  'fastmail.com': { imapHost: 'imap.fastmail.com', imapPort: 993, smtpHost: 'smtp.fastmail.com', smtpPort: 587, allowInsecure: false },
  'qq.com': { imapHost: 'imap.qq.com', imapPort: 993, smtpHost: 'smtp.qq.com', smtpPort: 587, allowInsecure: false },
  '163.com': { imapHost: 'imap.163.com', imapPort: 993, smtpHost: 'smtp.163.com', smtpPort: 465, allowInsecure: false },
};

export const LoginForm: React.FC = () => {
  const { login, verify2fa } = useAuthStore();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  // 2FA 狀態
  const [challenge, setChallenge] = useState<string | null>(null);
  const [twoFACode, setTwoFACode] = useState('');
  const [twoFALoading, setTwoFALoading] = useState(false);

  // 背景自動維護的伺服器參數（預設隱藏）
  const [imapHost, setImapHost] = useState('');
  const [imapPort, setImapPort] = useState(993);
  const [smtpHost, setSmtpHost] = useState('');
  const [smtpPort, setSmtpPort] = useState(587);
  const [allowInsecureTls, setAllowInsecureTls] = useState(false); // 預設不允許自簽憑證，僅由使用者明確勾選開啟
  const [serverDefaults, setServerDefaults] = useState<ServerDefaults | null>(null);

  const [detectedDomain, setDetectedDomain] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 載入伺服器預設值（容器環境變數設定之 IMAP / SMTP 預設）
  useEffect(() => {
    fetch('/api/server-config')
      .then((r) => r.json())
      .then((data) => {
        if (data?.success && data?.data?.defaults) {
          const d = data.data.defaults as ServerDefaults;
          setServerDefaults(d);
          if (d.imapHost) setImapHost(d.imapHost);
          if (d.imapPort) setImapPort(d.imapPort);
          if (d.smtpHost) setSmtpHost(d.smtpHost);
          if (d.smtpPort) setSmtpPort(d.smtpPort);
          if (typeof d.allowInsecureTls === 'boolean') setAllowInsecureTls(d.allowInsecureTls);
        }
      })
      .catch(() => {});
  }, []);

  // 輸入 Email 自動解析並填入伺服器配置
  const handleEmailChange = (val: string) => {
    setEmail(val);
    const atIndex = val.lastIndexOf('@');
    if (atIndex > 0 && atIndex < val.length - 1) {
      const domain = val.slice(atIndex + 1).toLowerCase().trim();

      if (KNOWN_DOMAINS[domain]) {
        const known = KNOWN_DOMAINS[domain];
        setImapHost(known.imapHost);
        setImapPort(known.imapPort);
        setSmtpHost(known.smtpHost);
        setSmtpPort(known.smtpPort);
        setAllowInsecureTls(known.allowInsecure ?? false);
        setDetectedDomain(domain);
      } else if (domain.includes('.')) {
        // 自訂網域（例如 example.com）— 若伺服器已預設 IMAP/SMTP，沿用之；否則以網域作為主機
        if (!serverDefaults?.imapHost) setImapHost(domain);
        if (!serverDefaults?.smtpHost) setSmtpHost(domain);
        setDetectedDomain(domain);
      }
    } else {
      setDetectedDomain(null);
    }
  };

  // 當 email 只填 user part，且 IMAP server host 已確定 → 顯示補全後嘅完整地址（一律用 imap server）
  const autofillHint = (() => {
    const v = email.trim();
    if (!v || v.includes('@')) return '';
    const domain = imapHost || '';
    if (!domain) return '';
    return `${v}@${domain}`;
  })();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !password) {
      setError('請輸入電子郵件與密碼');
      return;
    }

    // 若未自動填寫（使用者未打完整 domain），嘗試自 email 提取
    let finalImapHost = imapHost;
    let finalSmtpHost = smtpHost;

    if (!finalImapHost || !finalSmtpHost) {
      const atIndex = email.lastIndexOf('@');
      if (atIndex > 0) {
        const domain = email.slice(atIndex + 1).trim();
        finalImapHost = finalImapHost || domain;
        finalSmtpHost = finalSmtpHost || domain;
      }
    }

    if (!finalImapHost || !finalSmtpHost) {
      setError('無法自動判斷郵件伺服器，請展開進階設定輸入主機位址');
      setShowAdvanced(true);
      return;
    }

    // 若 email 只輸入 user part（無 @domain），自動以伺服器 host 補全 domain
    const atIdx = email.lastIndexOf('@');
    let finalEmail = email.trim();
    if (atIdx <= 0) {
      finalEmail = `${email.trim()}@${finalImapHost}`;
    }

    setLoading(true);
    setError(null);

    try {
      const result = await login({
        email: finalEmail,
        password,
        imapHost: finalImapHost,
        imapPort: imapPort || 993,
        imapUseTls: true,
        imapAllowInsecureTls: allowInsecureTls,
        smtpHost: finalSmtpHost,
        smtpPort: smtpPort || 587,
        smtpUseTls: true,
        smtpAllowInsecureTls: allowInsecureTls,
      });

      // 需要第二階段驗證
      if (result?.requires2fa) {
        setChallenge(result.challenge);
        setPassword('');
      }
    } catch (err: any) {
      setError(err.message || '登入失敗，請檢查密碼或展開進階設定確認伺服器主機');
    } finally {
      setLoading(false);
    }
  };

  const handleTwoFASubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!challenge || !twoFACode.trim()) {
      setError('請輸入驗證碼');
      return;
    }

    setTwoFALoading(true);
    setError(null);

    try {
      await verify2fa(challenge, twoFACode.trim());
    } catch (err: any) {
      setError(err.message || '驗證碼錯誤，請重試');
      setTwoFACode('');
    } finally {
      setTwoFALoading(false);
    }
  };

  const handleBackToCredentials = () => {
    setChallenge(null);
    setTwoFACode('');
    setError(null);
  };

  return (
    <div className="min-h-[100dvh] w-full flex items-center justify-center bg-gradient-to-br from-sky-50 via-white to-blue-50 p-4 sm:p-6 select-none">
      <div className="w-full max-w-[420px] bg-white rounded-3xl shadow-xl shadow-sky-500/10 border border-sky-100/60 p-6 sm:p-8 transition-all duration-300">
        {/* 簡約頂部 Logo 與標題 */}
        <div className="text-center mb-7 sm:mb-8">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-gradient-to-br from-sky-400 to-blue-500 text-white mb-4 shadow-lg shadow-sky-500/30">
            <Mail className="w-6 h-6" />
          </div>
          <h1 className="text-2xl font-bold text-slate-900 tracking-tight">
            登入 Webmail
          </h1>
          <p className="text-sm text-slate-500 mt-1.5">
            輸入帳號與密碼即可自動連線
          </p>
        </div>

        {/* 錯誤提示 */}
        {error && (
          <div className="mb-5 flex items-start gap-2.5 p-3.5 rounded-xl bg-red-50 text-red-700 text-xs border border-red-200/60 leading-relaxed animate-in fade-in">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <span className="break-all">{error}</span>
          </div>
        )}

        {/* 帳號加密儲存提示（首次登入即建立帳號） */}
        {!challenge && (
          <div className="mb-5 flex items-start gap-2.5 p-3.5 rounded-xl bg-amber-50 text-amber-800 text-xs border border-amber-200/70 leading-relaxed animate-in fade-in">
            <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5" />
            <span>
              首次登入即建立你的郵件帳號。帳號密碼會<strong className="font-semibold">加密儲存於伺服器</strong>；請緊記你嘅登入密碼——遺失將永久無法解鎖所有帳號。
            </span>
          </div>
        )}

        {challenge ? (
          /* 2FA 驗證步驟 */
          <form onSubmit={handleTwoFASubmit} className="space-y-4">
            <div className="flex items-start gap-3 p-3.5 rounded-xl bg-blue-50 border border-blue-200/60">
              <KeyRound className="w-5 h-5 text-blue-600 shrink-0 mt-0.5" />
              <div className="text-xs text-blue-800 leading-relaxed">
                <div className="font-bold mb-0.5">兩步驟驗證 (2FA)</div>
                此帳號已啟用兩步驟驗證。請輸入 Authenticator App 顯示嘅 6 位數驗證碼，或其中一個備份碼。
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                驗證碼
              </label>
              <input
                type="text"
                required
                autoFocus
                autoComplete="one-time-code"
                inputMode="numeric"
                value={twoFACode}
                onChange={(e) => setTwoFACode(e.target.value)}
                placeholder="••••••"
                className="w-full px-3.5 py-3 text-sm text-center tracking-[0.5em] font-mono bg-slate-50 border border-slate-200 rounded-xl outline-none focus:ring-2 focus:ring-sky-400 focus:border-sky-400 focus:bg-white text-slate-900 placeholder:text-slate-400 transition"
              />
            </div>

            <button
              type="submit"
              disabled={twoFALoading}
              className="w-full py-3 px-4 bg-gradient-to-r from-sky-500 to-blue-500 hover:from-sky-600 hover:to-blue-600 active:scale-[0.99] text-white rounded-xl text-sm font-semibold transition shadow-lg shadow-sky-500/25 flex items-center justify-center gap-2 disabled:opacity-50"
            >
              {twoFALoading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  正在驗證...
                </>
              ) : (
                '驗證並登入'
              )}
            </button>

            <button
              type="button"
              onClick={handleBackToCredentials}
              className="w-full flex items-center justify-center gap-1.5 text-xs text-slate-500 hover:text-sky-600 transition font-medium"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              返回重新輸入帳號密碼
            </button>
          </form>
        ) : (
        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Email 輸入框 */}
          <div>
            <div className="flex items-center justify-between mb-1.5 gap-2">
              <label className="block text-xs font-semibold text-slate-700">
                電子郵件地址
              </label>
              {detectedDomain && (
                <span className="flex items-center gap-1 text-[11px] text-sky-600 font-medium animate-in fade-in shrink-0">
                  <Sparkles className="w-3 h-3" />
                  自動適配 @{detectedDomain}
                </span>
              )}
            </div>
            <div className="relative">
              <Mail className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                required
                autoFocus
                value={email}
                onChange={(e) => handleEmailChange(e.target.value)}
                placeholder="user@example.com"
                className="w-full pl-10 pr-3.5 py-3 text-sm bg-slate-50 border border-slate-200 rounded-xl outline-none focus:ring-2 focus:ring-sky-400 focus:border-sky-400 focus:bg-white text-slate-900 placeholder:text-slate-400 transition"
              />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] text-slate-300 dark:text-slate-600 pointer-events-none hidden sm:block">
                {autofillHint}
              </span>
            </div>
            {autofillHint && (
              <p className="mt-1 text-[10px] text-slate-400">
                將以 <span className="font-mono text-slate-500">{autofillHint}</span> 登入（可省略 @網域部分）
              </p>
            )}
          </div>

          {/* 密碼輸入框 */}
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1.5">
              郵件密碼
            </label>
            <div className="relative">
              <Lock className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type={showPassword ? 'text' : 'password'}
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                className="w-full pl-10 pr-10 py-3 text-sm bg-slate-50 border border-slate-200 rounded-xl outline-none focus:ring-2 focus:ring-sky-400 focus:border-sky-400 focus:bg-white text-slate-900 placeholder:text-slate-400 transition"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 p-0.5"
                aria-label={showPassword ? '隱藏密碼' : '顯示密碼'}
              >
                {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>

          {/* 預設隱藏的進階設定（可折疊） */}
          <div className="pt-1">
            <button
              type="button"
              onClick={() => setShowAdvanced(!showAdvanced)}
              className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-sky-600 transition font-medium select-none"
            >
              <Server className="w-3.5 h-3.5" />
              <span>{showAdvanced ? '隱藏進階伺服器設定' : '進階伺服器設定'}</span>
              {showAdvanced ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
            </button>

            {showAdvanced && (
              <div className="mt-3 p-3.5 bg-slate-50 rounded-2xl border border-slate-200 space-y-3 animate-in fade-in duration-150">
                <div>
                  <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                    IMAP 伺服器 (收信)
                  </label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={imapHost}
                      onChange={(e) => setImapHost(e.target.value)}
                      placeholder="example.com"
                      className="flex-1 min-w-0 px-3 py-1.5 text-xs bg-white border border-slate-200 rounded-lg outline-none focus:ring-2 focus:ring-sky-400 focus:border-sky-400"
                    />
                    <input
                      type="number"
                      value={imapPort}
                      onChange={(e) => setImapPort(parseInt(e.target.value) || 993)}
                      className="w-16 px-2 py-1.5 text-xs bg-white border border-slate-200 rounded-lg outline-none focus:ring-2 focus:ring-sky-400 focus:border-sky-400 text-center"
                      placeholder="993"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                    SMTP 伺服器 (發信)
                  </label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={smtpHost}
                      onChange={(e) => setSmtpHost(e.target.value)}
                      placeholder="example.com"
                      className="flex-1 min-w-0 px-3 py-1.5 text-xs bg-white border border-slate-200 rounded-lg outline-none focus:ring-2 focus:ring-sky-400 focus:border-sky-400"
                    />
                    <input
                      type="number"
                      value={smtpPort}
                      onChange={(e) => setSmtpPort(parseInt(e.target.value) || 587)}
                      className="w-16 px-2 py-1.5 text-xs bg-white border border-slate-200 rounded-lg outline-none focus:ring-2 focus:ring-sky-400 focus:border-sky-400 text-center"
                      placeholder="587"
                    />
                  </div>
                </div>

                <div className="pt-1">
                  <label className="flex items-center gap-2 cursor-pointer select-none text-[11px] text-slate-600">
                    <input
                      type="checkbox"
                      checked={allowInsecureTls}
                      onChange={(e) => setAllowInsecureTls(e.target.checked)}
                      className="w-3.5 h-3.5 rounded border-slate-300 text-sky-500 focus:ring-sky-400"
                    />
                    <span className="flex items-center gap-1">
                      <ShieldAlert className="w-3 h-3 text-amber-500 shrink-0" />
                      允許自簽/未驗證的 TLS 憑證
                    </span>
                  </label>
                </div>
              </div>
            )}
          </div>

          {/* 登入按鈕 */}
          <button
            type="submit"
            disabled={loading}
            className="w-full py-3 px-4 bg-gradient-to-r from-sky-500 to-blue-500 hover:from-sky-600 hover:to-blue-600 active:scale-[0.99] text-white rounded-xl text-sm font-semibold transition shadow-lg shadow-sky-500/25 flex items-center justify-center gap-2 disabled:opacity-50 mt-2"
          >
            {loading ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                正在登入...
              </>
            ) : (
              '登入信箱'
            )}
          </button>
        </form>
        )}
        {/* 版本資訊 */}
        <div className="text-center mt-6 text-[11px] text-slate-400">
          Version: {import.meta.env.VITE_APP_VERSION || 'vdev'}
          {import.meta.env.VITE_APP_COMMIT_HASH && import.meta.env.VITE_APP_COMMIT_HASH !== 'sha-unknown' ? ` · ${String(import.meta.env.VITE_APP_COMMIT_HASH).slice(0, 7)}` : ''}
        </div>
      </div>
    </div>
  );
};
