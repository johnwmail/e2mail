package handler

import (
	"encoding/json"
	"log"
	"net/http"
	"strings"
	"time"

	"modern-webmail/backend/internal/api/middleware"
	"modern-webmail/backend/internal/auth"
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
	if twoFA, _ := h.storage.GetTwoFA(normalizeEmail(req.Email)); twoFA != nil {
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

	// 2. 建立並加密儲存 Session
	newSess := &session.Session{
		Email:                req.Email,
		Username:             username,
		IMAPHost:             req.IMAPHost,
		IMAPPort:             imapPort,
		IMAPUseTLS:           imapUseTLS,
		IMAPAllowInsecureTLS: req.IMAPAllowInsecureTLS,
		SMTPHost:             req.SMTPHost,
		SMTPPort:             smtpPort,
		SMTPUseTLS:           smtpUseTLS,
		SMTPAllowInsecureTLS: req.SMTPAllowInsecureTLS,
	}

	savedSess, err := h.store.Create(newSess, req.Password)
	if err != nil {
		log.Printf("[AUTH ERROR] Session create failed: %v", err)
		response.InternalServerError(w, "failed to create session")
		return
	}

	// 3. 啟動背景 IDLE 監聽
	_ = h.idleMgr.GetOrStartListener(savedSess, req.Password)

	// 4. 設定 HttpOnly Cookie
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
	newSess := &session.Session{
		Email:                pl.Email,
		Username:             pl.Username,
		IMAPHost:             pl.IMAPHost,
		IMAPPort:             pl.IMAPPort,
		IMAPUseTLS:           pl.IMAPUseTLS,
		IMAPAllowInsecureTLS: pl.IMAPAllowInsecureTLS,
		SMTPHost:             pl.SMTPHost,
		SMTPPort:             pl.SMTPPort,
		SMTPUseTLS:           pl.SMTPUseTLS,
		SMTPAllowInsecureTLS: pl.SMTPAllowInsecureTLS,
	}

	savedSess, err := h.store.Create(newSess, pl.Password)
	if err != nil {
		log.Printf("[AUTH ERROR] Session create failed after 2FA: %v", err)
		response.InternalServerError(w, "failed to create session")
		return
	}

	_ = h.idleMgr.GetOrStartListener(savedSess, pl.Password)
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
		h.idleMgr.StopListener(sess.ID)
		h.poolMgr.DestroyPool(sess.ID)
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
