package handler

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strings"
	"time"

	"modern-webmail/backend/internal/api/middleware"
	"modern-webmail/backend/internal/auth"
	"modern-webmail/backend/internal/crypto"
	"modern-webmail/backend/internal/imap"
	"modern-webmail/backend/internal/session"
	"modern-webmail/backend/internal/storage"
	"modern-webmail/backend/pkg/response"
)

// AuthHandler 處理登入、登出與身分校驗
type AuthHandler struct {
	store         session.Store
	storage       storage.Store
	poolMgr       *imap.PoolManager
	idleMgr       *imap.IdleManager
	pendingLogin  *auth.PendingLoginStore
}

// NewAuthHandler 初始化 AuthHandler
func NewAuthHandler(store session.Store, storageStore storage.Store, poolMgr *imap.PoolManager, idleMgr *imap.IdleManager) *AuthHandler {
	return &AuthHandler{
		store:        store,
		storage:      storageStore,
		poolMgr:      poolMgr,
		idleMgr:      idleMgr,
		pendingLogin: auth.NewPendingLoginStore(3 * time.Minute),
	}
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

	// 4. 建立 Session（自帶 accounts + 加密 DEK）
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

	// 5. 啟動背景 IDLE 監聽（所有帳號）
	h.startIdleForAccounts(savedSess, dek, accounts)

	// 6. 設定 HttpOnly Cookie
	http.SetCookie(w, &http.Cookie{
		Name:     "webmail_session",
		Value:    savedSess.ID,
		Path:     "/",
		Expires:  time.Now().Add(24 * time.Hour),
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   r.TLS != nil,
	})

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

	// 驗證 TOTP code
	if auth.ValidateCode(twoFA.Secret, code) {
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

	http.SetCookie(w, &http.Cookie{
		Name:     "webmail_session",
		Value:    savedSess.ID,
		Path:     "/",
		Expires:  time.Now().Add(24 * time.Hour),
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   r.TLS != nil,
	})

	log.Printf("[AUTH SUCCESS] Login successful for %s (Session ID: %s, via 2FA)", pl.Email, savedSess.ID)
	response.Success(w, LoginResponse{
		Token:   savedSess.ID,
		Session: savedSess,
	})
}

func normalizeEmail(email string) string {
	return strings.ToLower(strings.TrimSpace(email))
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
		HttpOnly: true,
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
