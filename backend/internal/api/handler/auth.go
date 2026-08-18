package handler

import (
	"encoding/json"
	"log"
	"net/http"
	"time"

	"modern-webmail/backend/internal/api/middleware"
	"modern-webmail/backend/internal/imap"
	"modern-webmail/backend/internal/session"
	"modern-webmail/backend/pkg/response"
)

// AuthHandler 處理登入、登出與身分校驗
type AuthHandler struct {
	store   session.Store
	poolMgr *imap.PoolManager
	idleMgr *imap.IdleManager
}

// NewAuthHandler 初始化 AuthHandler
func NewAuthHandler(store session.Store, poolMgr *imap.PoolManager, idleMgr *imap.IdleManager) *AuthHandler {
	return &AuthHandler{
		store:   store,
		poolMgr: poolMgr,
		idleMgr: idleMgr,
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
	Token   string           `json:"token"`
	Session *session.Session `json:"session"`
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
