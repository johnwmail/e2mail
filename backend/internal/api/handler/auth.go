package handler

import (
	"encoding/base32"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/johnwmail/e2mail/backend/internal/api/middleware"
	"github.com/johnwmail/e2mail/backend/internal/auth"
	"github.com/johnwmail/e2mail/backend/internal/config"
	"github.com/johnwmail/e2mail/backend/internal/crypto"
	"github.com/johnwmail/e2mail/backend/internal/imap"
	"github.com/johnwmail/e2mail/backend/internal/ldap"
	"github.com/johnwmail/e2mail/backend/internal/session"
	"github.com/johnwmail/e2mail/backend/internal/storage"
	"github.com/johnwmail/e2mail/backend/pkg/response"
)

// AuthHandler 處理登入、登出與身分校驗
type AuthHandler struct {
	store        session.Store
	storage      storage.Store
	poolMgr      *imap.PoolManager
	idleMgr      *imap.IdleManager
	pendingLogin *auth.PendingLoginStore
	cfg          *config.ServerConfig
	sessionTTL   time.Duration
	pwChanger    passwordChanger
	pwLimiter    *auth.AttemptLimiter
}

// passwordChanger 抽象 ldap.Client，方便測試注入
type passwordChanger interface {
	UserDN(email string) (string, error)
	VerifyUserBind(userDN, password string) error
	ChangePassword(userDN, newPassword string) error
}

// NewAuthHandler 初始化 AuthHandler
func NewAuthHandler(store session.Store, storageStore storage.Store, poolMgr *imap.PoolManager, idleMgr *imap.IdleManager, cfg *config.ServerConfig, sessionTTL time.Duration) *AuthHandler {
	if sessionTTL <= 0 {
		sessionTTL = 24 * time.Hour
	}
	return &AuthHandler{
		store:        store,
		storage:      storageStore,
		poolMgr:      poolMgr,
		idleMgr:      idleMgr,
		pendingLogin: auth.NewPendingLoginStore(3 * time.Minute),
		cfg:          cfg,
		sessionTTL:   sessionTTL,
		pwLimiter:    auth.NewAttemptLimiter(),
	}
}

// SetPasswordChanger 注入 LDAP 密碼變更客戶端（LDAP 未啟用時保持 nil）
func (h *AuthHandler) SetPasswordChanger(c passwordChanger) {
	h.pwChanger = c
}

// cookieSecure 根據 COOKIE_SECURE 設定決定 Secure flag（預設 true）
// 若 cfg 為 nil 則 fallback 到 r.TLS 判斷，支援反向代理場景
func (h *AuthHandler) cookieSecure(r *http.Request) bool {
	if h.cfg != nil {
		return h.cfg.CookieSecure
	}
	return r.TLS != nil
}

// setSessionCookie 統一設定 session cookie（TTL 與 Secure 由 env 控制）
func (h *AuthHandler) setSessionCookie(w http.ResponseWriter, r *http.Request, sessionID string) {
	http.SetCookie(w, &http.Cookie{
		Name:     "webmail_session",
		Value:    sessionID,
		Path:     "/",
		Expires:  time.Now().Add(h.sessionTTL),
		MaxAge:   int(h.sessionTTL.Seconds()),
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   h.cookieSecure(r),
	})
}

// LoginRequest 登入參數結構
type LoginRequest struct {
	Email                string `json:"email"`
	Username             string `json:"username,omitempty"`
	Password             string `json:"password"`
	IMAPHost             string `json:"imapHost"`
	IMAPPort             int    `json:"imapPort,omitempty"`
	IMAPUseTLS           *bool  `json:"imapUseTls,omitempty"`
	IMAPAllowInsecureTLS bool   `json:"imapAllowInsecureTls,omitempty"`
	SMTPHost             string `json:"smtpHost"`
	SMTPPort             int    `json:"smtpPort,omitempty"`
	SMTPUseTLS           *bool  `json:"smtpUseTls,omitempty"`
	SMTPAllowInsecureTLS bool   `json:"smtpAllowInsecureTls,omitempty"`
}

// LoginResponse 登入成功回應結構
type LoginResponse struct {
	Token       string           `json:"token,omitempty"`
	Session     *session.Session `json:"session,omitempty"`
	Requires2FA bool             `json:"requires2fa,omitempty"`
	Challenge   string           `json:"challenge,omitempty"`
}

// Verify2FARequest 2FA 驗證參數結構
type Verify2FARequest struct {
	Challenge string `json:"challenge"`
	Code      string `json:"code"`
}

// Login 處理使用者登入並驗證 IMAP 連線
func (h *AuthHandler) Login(w http.ResponseWriter, r *http.Request) {
	var req LoginRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		response.BadRequest(w, "invalid request body format")
		return
	}

	if req.Email == "" || req.Password == "" || req.IMAPHost == "" || req.SMTPHost == "" {
		response.BadRequest(w, "email, password, imapHost, and smtpHost are required")
		return
	}

	username := req.Username
	if username == "" {
		username = req.Email
	}

	imapPort := req.IMAPPort
	if imapPort <= 0 {
		imapPort = 993
	}

	imapUseTLS := true
	if req.IMAPUseTLS != nil {
		imapUseTLS = *req.IMAPUseTLS
	}

	smtpPort := req.SMTPPort
	if smtpPort <= 0 {
		smtpPort = 587
	}

	smtpUseTLS := true
	if req.SMTPUseTLS != nil {
		smtpUseTLS = *req.SMTPUseTLS
	}

	ownerEmail := normalizeEmail(req.Email)

	log.Printf("[AUTH] Login attempt for email: %s, IMAP: %s:%d (TLS: %v, AllowInsecure: %v), SMTP: %s:%d",
		req.Email, req.IMAPHost, imapPort, imapUseTLS, req.IMAPAllowInsecureTLS, req.SMTPHost, smtpPort)

	// 1. 嘗試連線並驗證 IMAP 憑證
	testClient, err := imap.NewClient(imap.ConnectionConfig{
		Host:             req.IMAPHost,
		Port:             imapPort,
		UseTLS:           imapUseTLS,
		AllowInsecureTLS: req.IMAPAllowInsecureTLS,
		Username:         username,
		Password:         req.Password,
	})
	if err != nil {
		log.Printf("[AUTH ERROR] IMAP auth failed for %s: %v", req.Email, err)
		response.Unauthorized(w, "IMAP authentication failed: "+err.Error())
		return
	}
	_ = testClient.Close()

	// 1.5 若使用者已啟用 2FA，先建立 pending challenge，等待驗證碼
	if twoFA, _ := h.storage.GetTwoFA(ownerEmail); twoFA != nil {
		challenge := h.pendingLogin.Create(&auth.PendingLogin{
			Email:                req.Email,
			Username:             username,
			Password:             req.Password,
			IMAPHost:             req.IMAPHost,
			IMAPPort:             imapPort,
			IMAPUseTLS:           imapUseTLS,
			IMAPAllowInsecureTLS: req.IMAPAllowInsecureTLS,
			SMTPHost:             req.SMTPHost,
			SMTPPort:             smtpPort,
			SMTPUseTLS:           smtpUseTLS,
			SMTPAllowInsecureTLS: req.SMTPAllowInsecureTLS,
		})
		log.Printf("[AUTH] 2FA required for %s (challenge created)", req.Email)
		response.Success(w, LoginResponse{
			Requires2FA: true,
			Challenge:   challenge,
		})
		return
	}

	// 2. 建立或解鎖憑證（MasterKey = 首帳號 IMAP 密碼，wrap DEK）
	cred, dek, err := h.resolveCredential(ownerEmail, req.Password)
	if err != nil {
		log.Printf("[AUTH ERROR] credential resolve failed for %s: %v", req.Email, err)
		response.Unauthorized(w, err.Error())
		return
	}

	// 3. 建立首帳號（若呢個 user 仲未有 account）
	accounts, err := h.accountsWithPassword(ownerEmail, cred, dek)
	if err != nil {
		log.Printf("[AUTH ERROR] accounts load failed for %s: %v", req.Email, err)
		response.InternalServerError(w, "failed to load accounts")
		return
	}
	if len(accounts) == 0 {
		// 首登入：用登入表單資料建立首帳號
		acc := &storage.Account{
			UserEmail:            ownerEmail,
			Label:                req.Email,
			Email:                req.Email,
			IMAPHost:             req.IMAPHost,
			IMAPPort:             imapPort,
			IMAPUseTLS:           imapUseTLS,
			IMAPAllowInsecureTLS: req.IMAPAllowInsecureTLS,
			SMTPHost:             req.SMTPHost,
			SMTPPort:             smtpPort,
			SMTPUseTLS:           smtpUseTLS,
			SMTPAllowInsecureTLS: req.SMTPAllowInsecureTLS,
			Username:             username,
			EncIMAPPassword:      req.Password,
			EncSMTPPassword:      req.Password,
			IsDefault:            true,
			SortOrder:            0,
		}
		if err := h.encryptAccountPasswords(acc, dek); err != nil {
			log.Printf("[AUTH ERROR] encrypt account passwords failed: %v", err)
			response.InternalServerError(w, "failed to encrypt account credentials")
			return
		}
		if err := h.storage.CreateAccount(acc); err != nil {
			log.Printf("[AUTH ERROR] create account failed for %s: %v", req.Email, err)
			response.InternalServerError(w, "failed to create account")
			return
		}
		accounts = append(accounts, *acc)
	}

	// 4. 一次性遷移：若 2FA secret 仍明文，立即用 DEK 加密（手動塞明文後下次登入自動轉密文）
	h.maybeMigrateTwoFA(ownerEmail, dek)

	// 5. 建立 Session（自帶 accounts + 加密 DEK）
	newSess := &session.Session{
		Email:    ownerEmail,
		Username: username,
		Accounts: accounts,
	}
	savedSess, err := h.store.Create(newSess, dek)
	if err != nil {
		log.Printf("[AUTH ERROR] Session create failed: %v", err)
		response.InternalServerError(w, "failed to create session")
		return
	}

	// 6. 啟動背景 IDLE 監聽（所有帳號）
	h.startIdleForAccounts(savedSess, dek, accounts)

	// 6. 設定 HttpOnly Cookie（TTL 與 Secure 由 env 控制）
	h.setSessionCookie(w, r, savedSess.ID)

	log.Printf("[AUTH SUCCESS] Login successful for %s (Session ID: %s)", req.Email, savedSess.ID)

	response.Success(w, LoginResponse{
		Token:   savedSess.ID,
		Session: savedSess,
	})
}

// resolveCredential 取得使用者憑證包同 DEK。首次（無 credential）則生成。
func (h *AuthHandler) resolveCredential(ownerEmail, masterPassword string) (*storage.UserCredential, []byte, error) {
	cred, err := h.storage.GetUserCredential(ownerEmail)
	if err != nil {
		return nil, nil, err
	}

	if cred == nil {
		// 首次登入：生成 salt + DEK + wrapped_dek
		salt, err := crypto.GenerateSalt()
		if err != nil {
			return nil, nil, err
		}
		dek, err := crypto.GenerateDEK()
		if err != nil {
			return nil, nil, err
		}
		masterKey := crypto.DeriveMasterKey(masterPassword, salt)
		wrappedDEK, err := crypto.Encrypt(masterKey, dek)
		if err != nil {
			return nil, nil, err
		}
		cred = &storage.UserCredential{
			UserEmail:  ownerEmail,
			Salt:       salt,
			WrappedDEK: wrappedDEK,
		}
		if err := h.storage.CreateUserCredential(cred); err != nil {
			return nil, nil, err
		}
		return cred, dek, nil
	}

	// 已存在：解 wrap DEK
	dek, err := crypto.Decrypt(crypto.DeriveMasterKey(masterPassword, cred.Salt), cred.WrappedDEK)
	if err != nil {
		return nil, nil, errors.New("credentials unlock failed — 登入密碼不正確")
	}
	return cred, dek, nil
}

// accountsWithPassword 載入 user 嘅所有帳號（保留加密密碼欄位，由 middleware 解密）
func (h *AuthHandler) accountsWithPassword(ownerEmail string, cred *storage.UserCredential, dek []byte) ([]storage.Account, error) {
	accounts, err := h.storage.ListAccounts(ownerEmail)
	if err != nil {
		return nil, err
	}
	return accounts, nil
}

// encryptAccountPasswords 用 DEK 加密帳號密碼（寫入 Enc 欄位）
func (h *AuthHandler) encryptAccountPasswords(acc *storage.Account, dek []byte) error {
	imapEnc, err := crypto.Encrypt(dek, []byte(acc.EncIMAPPassword))
	if err != nil {
		return err
	}
	smtpEnc, err := crypto.Encrypt(dek, []byte(acc.EncSMTPPassword))
	if err != nil {
		return err
	}
	acc.EncIMAPPassword = imapEnc
	acc.EncSMTPPassword = smtpEnc
	return nil
}

// startIdleForAccounts 為每個帳號啟動 IDLE 監聽
func (h *AuthHandler) startIdleForAccounts(sess *session.Session, dek []byte, accounts []storage.Account) {
	for i := range accounts {
		acc := &accounts[i]
		imapPass, err := crypto.Decrypt(dek, acc.EncIMAPPassword)
		if err != nil {
			log.Printf("[IDLE] failed to decrypt password for account %s: %v", acc.ID, err)
			continue
		}
		config := imap.ConnectionConfig{
			Host:             acc.IMAPHost,
			Port:             acc.IMAPPort,
			UseTLS:           acc.IMAPUseTLS,
			AllowInsecureTLS: acc.IMAPAllowInsecureTLS,
			Username:         acc.Username,
			Password:         string(imapPass),
		}
		_ = h.idleMgr.GetOrStartListener(sess.ID, acc.ID, config, string(imapPass))
	}
}

// Verify2FA 驗證 TOTP 或備份碼，完成第二階段登入
func (h *AuthHandler) Verify2FA(w http.ResponseWriter, r *http.Request) {
	var req Verify2FARequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		response.BadRequest(w, "invalid request body format")
		return
	}
	if req.Challenge == "" || req.Code == "" {
		response.BadRequest(w, "challenge and code are required")
		return
	}

	pl := h.pendingLogin.Get(req.Challenge)
	if pl == nil {
		response.Unauthorized(w, "驗證已逾時或無效，請重新登入")
		return
	}

	twoFA, err := h.storage.GetTwoFA(normalizeEmail(pl.Email))
	if err != nil {
		response.InternalServerError(w, "failed to load 2FA settings")
		return
	}
	if twoFA == nil {
		h.pendingLogin.Delete(req.Challenge)
		response.Unauthorized(w, "此帳號未啟用兩步驟驗證")
		return
	}

	code := strings.TrimSpace(req.Code)

	// 用 master password unwrap DEK → 解密 TOTP secret（zero-knowledge at rest）
	secret := twoFA.Secret
	if _, dek, err := h.resolveCredential(normalizeEmail(pl.Email), pl.Password); err == nil && len(dek) > 0 {
		if dec, dErr := crypto.Decrypt(dek, twoFA.Secret); dErr == nil {
			secret = string(dec)
		}
		// decrypt 失敗則保留原值（backward compat：舊明文 secret）
	}

	// 驗證 TOTP code
	if auth.ValidateCode(secret, code) {
		h.completeLogin(w, r, pl, req.Challenge)
		return
	}

	// 驗證備份碼（一次性使用）
	if idx := auth.ValidateBackupCode(code, twoFA.BackupHashes); idx >= 0 {
		twoFA.BackupHashes = append(twoFA.BackupHashes[:idx], twoFA.BackupHashes[idx+1:]...)
		if len(twoFA.BackupHashes) == 0 {
			twoFA.BackupHashes = []string{}
		}
		if err := h.storage.SaveTwoFA(twoFA); err != nil {
			log.Printf("[AUTH ERROR] failed to consume backup code for %s: %v", pl.Email, err)
		}
		h.completeLogin(w, r, pl, req.Challenge)
		return
	}

	h.pendingLogin.MarkFailed(req.Challenge)
	log.Printf("[AUTH] 2FA code verification failed for %s", pl.Email)
	response.Unauthorized(w, "驗證碼錯誤，請重試")
}

// completeLogin 建立正式 Session 並返回登入成功
func (h *AuthHandler) completeLogin(w http.ResponseWriter, r *http.Request, pl *auth.PendingLogin, challenge string) {
	ownerEmail := normalizeEmail(pl.Email)

	cred, dek, err := h.resolveCredential(ownerEmail, pl.Password)
	if err != nil {
		log.Printf("[AUTH ERROR] credential resolve failed after 2FA for %s: %v", pl.Email, err)
		response.Unauthorized(w, err.Error())
		return
	}
	h.maybeMigrateTwoFA(ownerEmail, dek)

	accounts, err := h.accountsWithPassword(ownerEmail, cred, dek)
	if err != nil {
		log.Printf("[AUTH ERROR] accounts load failed after 2FA for %s: %v", pl.Email, err)
		response.InternalServerError(w, "failed to load accounts")
		return
	}
	if len(accounts) == 0 {
		acc := &storage.Account{
			UserEmail:            ownerEmail,
			Label:                pl.Email,
			Email:                pl.Email,
			IMAPHost:             pl.IMAPHost,
			IMAPPort:             pl.IMAPPort,
			IMAPUseTLS:           pl.IMAPUseTLS,
			IMAPAllowInsecureTLS: pl.IMAPAllowInsecureTLS,
			SMTPHost:             pl.SMTPHost,
			SMTPPort:             pl.SMTPPort,
			SMTPUseTLS:           pl.SMTPUseTLS,
			SMTPAllowInsecureTLS: pl.SMTPAllowInsecureTLS,
			Username:             pl.Username,
			EncIMAPPassword:      pl.Password,
			EncSMTPPassword:      pl.Password,
			IsDefault:            true,
			SortOrder:            0,
		}
		if err := h.encryptAccountPasswords(acc, dek); err != nil {
			response.InternalServerError(w, "failed to encrypt account credentials")
			return
		}
		if err := h.storage.CreateAccount(acc); err != nil {
			log.Printf("[AUTH ERROR] create account failed after 2FA: %v", err)
			response.InternalServerError(w, "failed to create account")
			return
		}
		accounts = append(accounts, *acc)
	}

	newSess := &session.Session{
		Email:    ownerEmail,
		Username: pl.Username,
		Accounts: accounts,
	}

	savedSess, err := h.store.Create(newSess, dek)
	if err != nil {
		log.Printf("[AUTH ERROR] Session create failed after 2FA: %v", err)
		response.InternalServerError(w, "failed to create session")
		return
	}

	h.startIdleForAccounts(savedSess, dek, accounts)
	h.pendingLogin.Delete(challenge)

	h.setSessionCookie(w, r, savedSess.ID)

	log.Printf("[AUTH SUCCESS] Login successful for %s (Session ID: %s, via 2FA)", pl.Email, savedSess.ID)
	response.Success(w, LoginResponse{
		Token:   savedSess.ID,
		Session: savedSess,
	})
}

func normalizeEmail(email string) string {
	return strings.ToLower(strings.TrimSpace(email))
}

// maybeMigrateTwoFA 若 two_fa.secret 仍明文（能 base32 decode 且 Decrypt 失敗），即用 DEK 加密並回寫
// 用於手動塞明文後下次登入自動轉密文（值不變，只加密）
func (h *AuthHandler) maybeMigrateTwoFA(ownerEmail string, dek []byte) {
	if len(dek) == 0 {
		return
	}
	twoFA, err := h.storage.GetTwoFA(ownerEmail)
	if err != nil || twoFA == nil {
		return
	}
	// 已加密則 Decrypt 成功，無需遷移
	if _, err := crypto.Decrypt(dek, twoFA.Secret); err == nil {
		return
	}
	// 嘗試當明文 base32 驗證（需符合 TOTP secret 格式）
	trimmed := strings.ToUpper(strings.TrimSpace(twoFA.Secret))
	trimmed = strings.ReplaceAll(trimmed, " ", "")
	trimmed = strings.ReplaceAll(trimmed, "-", "")
	trimmed = strings.TrimRight(trimmed, "=")
	if len(trimmed) < 16 {
		return
	}
	if _, err := base32.StdEncoding.WithPadding(base32.NoPadding).DecodeString(trimmed); err != nil {
		return
	}
	enc, err := crypto.Encrypt(dek, []byte(twoFA.Secret))
	if err != nil {
		log.Printf("[2FA MIGRATE] encrypt failed for %s: %v", ownerEmail, err)
		return
	}
	twoFA.Secret = enc
	if err := h.storage.SaveTwoFA(twoFA); err != nil {
		log.Printf("[2FA MIGRATE] save failed for %s: %v", ownerEmail, err)
		return
	}
	log.Printf("[2FA MIGRATE] migrated plaintext 2FA secret to encrypted for %s", ownerEmail)
}

// Logout 登出並清理連線池與 IDLE
func (h *AuthHandler) Logout(w http.ResponseWriter, r *http.Request) {
	sess, ok := middleware.GetSessionFromContext(r.Context())
	if ok && sess != nil {
		h.idleMgr.StopSessionListeners(sess.ID)
		h.poolMgr.DestroySessionPools(sess.ID)
		_ = h.store.Delete(sess.ID)
	}

	// 清除 Cookie
	http.SetCookie(w, &http.Cookie{
		Name:     "webmail_session",
		Value:    "",
		Path:     "/",
		Expires:  time.Unix(0, 0),
		MaxAge:   -1,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   h.cookieSecure(r),
	})

	response.Success(w, map[string]string{"message": "logged out successfully"})
}

// Me 取得當前會話資訊
func (h *AuthHandler) Me(w http.ResponseWriter, r *http.Request) {
	sess, ok := middleware.GetSessionFromContext(r.Context())
	if !ok || sess == nil {
		response.Unauthorized(w, "unauthorized")
		return
	}

	response.Success(w, sess)
}

// ChangePasswordRequest 變更密碼請求體
type ChangePasswordRequest struct {
	OldPassword     string `json:"oldPassword"`
	NewPassword     string `json:"newPassword"`
	ConfirmPassword string `json:"confirmPassword"`
}

const (
	minNewPasswordLen     = 8
	pwChangeMaxFailures   = 10
	pwChangeFailureWindow = 10 * time.Minute
)

// ChangePassword 將新密碼寫入 OpenBSD ldapd（rootdn Modify userPassword={SSHA}），
// 再同步 re-wrap 本地 DEK 與 LDAP 身分帳號嘅儲存密碼。順序與回滾設計見 LDAP.md：
// self-bind 驗證舊密 → 預算本地新值 → LDAP 改密 → 本地寫入（失敗即回滾 LDAP）。
// Session DEK 由 server key 加密，故改密成功後當前 session 繼續有效（不強制登出）。
//nolint:gocyclo // 密碼變更流程含多段校驗與回滾分支，拆分會降低可讀性；複雜度與 address_contacts 匯入邏輯同級
func (h *AuthHandler) ChangePassword(w http.ResponseWriter, r *http.Request) {
	authCtx := middleware.GetAccountContext(r.Context())
	if authCtx == nil || authCtx.Session == nil || len(authCtx.DEK) == 0 {
		response.Unauthorized(w, "unauthorized")
		return
	}
	if h.pwChanger == nil || h.cfg == nil || !h.cfg.LDAP.Ready() {
		response.Forbidden(w, "LDAP password change is not enabled on this server")
		return
	}

	var req ChangePasswordRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		response.BadRequest(w, "invalid request body format")
		return
	}
	if req.OldPassword == "" || req.NewPassword == "" {
		response.BadRequest(w, "oldPassword and newPassword are required")
		return
	}
	if req.NewPassword != req.ConfirmPassword {
		response.BadRequest(w, "新密碼與確認密碼不一致")
		return
	}
	if len(req.NewPassword) < minNewPasswordLen {
		response.BadRequest(w, "新密碼至少 8 個字元")
		return
	}
	if req.NewPassword == req.OldPassword {
		response.BadRequest(w, "新密碼與舊密碼相同")
		return
	}

	ownerEmail := authCtx.Session.Email
	limiterKey := authCtx.Session.ID
	if h.pwLimiter.Blocked(limiterKey, pwChangeMaxFailures, pwChangeFailureWindow) {
		response.Error(w, http.StatusTooManyRequests, "失敗次數過多，請等待幾分鐘後再試")
		return
	}

	userDN, err := h.pwChanger.UserDN(ownerEmail)
	if err != nil {
		log.Printf("[PWCHANGE] build user DN failed for %s: %v", ownerEmail, err)
		response.InternalServerError(w, "failed to resolve LDAP user")
		return
	}

	// 1. 舊密碼權威驗證（用戶 self-bind；即使密碼曾喺 e2mail 之外改過都正確）
	if err := h.pwChanger.VerifyUserBind(userDN, req.OldPassword); err != nil {
		if errors.Is(err, ldap.ErrInvalidCredentials) {
			h.pwLimiter.RecordFailure(limiterKey)
			log.Printf("[PWCHANGE] old password verification failed for %s", ownerEmail)
			response.Unauthorized(w, "舊密碼不正確")
			return
		}
		log.Printf("[PWCHANGE] ldap verify error for %s: %v", ownerEmail, err)
		response.Error(w, http.StatusBadGateway, "無法連線至 LDAP 伺服器")
		return
	}

	// 2. 預算本地新憑證（DEK 不變，只換 wrap；減少 LDAP 已改而本地未同步嘅窗口）
	newSalt, err := crypto.GenerateSalt()
	if err != nil {
		response.InternalServerError(w, "failed to derive credentials")
		return
	}
	newWrappedDEK, err := crypto.Encrypt(crypto.DeriveMasterKey(req.NewPassword, newSalt), authCtx.DEK)
	if err != nil {
		response.InternalServerError(w, "failed to derive credentials")
		return
	}
	newEncPass, err := crypto.Encrypt(authCtx.DEK, []byte(req.NewPassword))
	if err != nil {
		response.InternalServerError(w, "failed to encrypt credentials")
		return
	}

	// 3. 寫入 ldapd
	if err := h.pwChanger.ChangePassword(userDN, req.NewPassword); err != nil {
		log.Printf("[PWCHANGE] ldap change failed for %s: %v", ownerEmail, err)
		if errors.Is(err, ldap.ErrInvalidCredentials) {
			response.Error(w, http.StatusBadGateway, "LDAP 服務帳號認證失敗，請聯絡管理員")
			return
		}
		response.Error(w, http.StatusBadGateway, "LDAP 伺服器拒絕了密碼變更")
		return
	}

	// 4. 本地同步（先帳號列、後憑證包；任何一步失敗都回滾先前寫入與 LDAP 端）
	accounts, err := h.storage.ListAccounts(ownerEmail)
	if err != nil {
		h.rollbackLDAP(userDN, req.OldPassword, ownerEmail, "list accounts after LDAP change")
		response.InternalServerError(w, "failed to sync password change")
		return
	}
	targetIdx := -1
	for i := range accounts {
		if normalizeEmail(accounts[i].Email) == ownerEmail {
			targetIdx = i
			break
		}
	}
	var origAcc storage.Account
	accUpdated := false
	if targetIdx >= 0 {
		origAcc = accounts[targetIdx] // 回滾用副本
		accounts[targetIdx].EncIMAPPassword = newEncPass
		accounts[targetIdx].EncSMTPPassword = newEncPass
		if err := h.storage.UpdateAccount(&accounts[targetIdx]); err != nil {
			log.Printf("[PWCHANGE] update account failed for %s: %v", ownerEmail, err)
			accounts[targetIdx] = origAcc
			h.rollbackLDAP(userDN, req.OldPassword, ownerEmail, "account update failed")
			response.InternalServerError(w, "failed to sync password change（已回滾）")
			return
		}
		accUpdated = true
	} else {
		log.Printf("[PWCHANGE] no LDAP-identity account row for %s; only DEK re-wrap applied", ownerEmail)
	}

	oldCred, err := h.storage.GetUserCredential(ownerEmail)
	if err != nil {
		log.Printf("[PWCHANGE] get old credential failed for %s: %v", ownerEmail, err)
	}
	newCred := &storage.UserCredential{UserEmail: ownerEmail, Salt: newSalt, WrappedDEK: newWrappedDEK}
	if oldCred != nil {
		err = h.storage.UpdateUserCredential(newCred)
	} else {
		err = h.storage.CreateUserCredential(newCred)
	}
	if err != nil {
		log.Printf("[PWCHANGE] re-wrap DEK failed for %s: %v", ownerEmail, err)
		if accUpdated {
			if rErr := h.storage.UpdateAccount(&origAcc); rErr != nil {
				log.Printf("[CRITICAL][PWCHANGE] account rollback failed for %s: %v", ownerEmail, rErr)
			}
		}
		if oldCred != nil {
			if rErr := h.storage.UpdateUserCredential(oldCred); rErr != nil {
				log.Printf("[CRITICAL][PWCHANGE] credential rollback failed for %s: %v", ownerEmail, rErr)
			}
		}
		h.rollbackLDAP(userDN, req.OldPassword, ownerEmail, "DEK re-wrap failed")
		response.InternalServerError(w, "failed to sync password change（已回滾）")
		return
	}

	// 5. 記憶體 session 同步 + 背景連線以新密碼重連
	authCtx.Session.Accounts = accounts
	newPasswords := make(map[string]string, len(accounts))
	for i := range accounts {
		if pass, dErr := crypto.Decrypt(authCtx.DEK, accounts[i].EncIMAPPassword); dErr == nil {
			newPasswords[accounts[i].ID] = string(pass)
		}
	}
	authCtx.Passwords = newPasswords
	if targetIdx >= 0 {
		h.restartAccountConnections(authCtx.Session, &accounts[targetIdx], req.NewPassword)
	}

	h.pwLimiter.Reset(limiterKey)
	log.Printf("[PWCHANGE] password changed successfully for %s", ownerEmail)
	response.Success(w, map[string]bool{"changed": true})
}

// rollbackLDAP 嘗試將 ldapd 端密碼恢復為舊值（best-effort，失敗只 log CRITICAL）
func (h *AuthHandler) rollbackLDAP(userDN, oldPassword, ownerEmail, reason string) {
	if err := h.pwChanger.ChangePassword(userDN, oldPassword); err != nil {
		log.Printf("[CRITICAL][PWCHANGE] %s for %s AND LDAP rollback failed: %v — 用戶需以新密碼登入或聯絡管理員", reason, ownerEmail, err)
		return
	}
	log.Printf("[PWCHANGE] %s for %s; LDAP password rolled back to old value", reason, ownerEmail)
}

// restartAccountConnections 作廢連線池並用新密碼重啟 IDLE
func (h *AuthHandler) restartAccountConnections(sess *session.Session, acc *storage.Account, plainPassword string) {
	h.poolMgr.DestroyPool(sess.ID, acc.ID)
	h.idleMgr.StopListener(sess.ID, acc.ID)
	config := imap.ConnectionConfig{
		Host:             acc.IMAPHost,
		Port:             acc.IMAPPort,
		UseTLS:           acc.IMAPUseTLS,
		AllowInsecureTLS: acc.IMAPAllowInsecureTLS,
		Username:         acc.Username,
		Password:         plainPassword,
	}
	_ = h.idleMgr.GetOrStartListener(sess.ID, acc.ID, config, plainPassword)
}
