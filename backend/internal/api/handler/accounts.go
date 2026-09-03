package handler

import (
	"encoding/json"
	"log"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/johnwmail/e2mail/backend/internal/api/middleware"
	"github.com/johnwmail/e2mail/backend/internal/config"
	"github.com/johnwmail/e2mail/backend/internal/crypto"
	imapinternal "github.com/johnwmail/e2mail/backend/internal/imap"
	"github.com/johnwmail/e2mail/backend/internal/session"
	"github.com/johnwmail/e2mail/backend/internal/smtp"
	"github.com/johnwmail/e2mail/backend/internal/storage"
	"github.com/johnwmail/e2mail/backend/pkg/response"
)

// AccountsHandler 管理郵件帳號 CRUD
type AccountsHandler struct {
	store   session.Store
	storage storage.Store
	poolMgr *imapinternal.PoolManager
	cfg     *config.ServerConfig
	idleMgr *imapinternal.IdleManager
}

// NewAccountsHandler 初始化 AccountsHandler
func NewAccountsHandler(store session.Store, storageStore storage.Store, poolMgr *imapinternal.PoolManager, idleMgr *imapinternal.IdleManager, cfg *config.ServerConfig) *AccountsHandler {
	return &AccountsHandler{
		store:   store,
		storage: storageStore,
		poolMgr: poolMgr,
		idleMgr: idleMgr,
		cfg:     cfg,
	}
}

// AccountRequest 帳號新增/編輯請求（密碼用臨時明文欄位，json:"password"）
type AccountRequest struct {
	Label                 string `json:"label"`
	Email                 string `json:"email"`
	IMAPHost              string `json:"imapHost"`
	IMAPPort              int    `json:"imapPort"`
	IMAPUseTLS            bool   `json:"imapUseTls"`
	IMAPAllowInsecureTLS  bool   `json:"imapAllowInsecureTls"`
	SMTPHost              string `json:"smtpHost"`
	SMTPPort              int    `json:"smtpPort"`
	SMTPUseTLS            bool   `json:"smtpUseTls"`
	SMTPAllowInsecureTLS  bool   `json:"smtpAllowInsecureTls"`
	SieveHost             string `json:"sieveHost"`
	SievePort             int    `json:"sievePort"`
	SieveUseTLS           bool   `json:"sieveUseTls"`
	SieveAllowInsecureTLS bool   `json:"sieveAllowInsecureTls"`
	Username              string `json:"username"`
	Password              string `json:"password"`
}

// OnboardingStatus 返回使用者 onboarding 完成度（依 REQUIRE_2FA / REQUIRE_PGP 環境變數決定邊啲係必須）
func (h *AccountsHandler) OnboardingStatus(w http.ResponseWriter, r *http.Request) {
	authCtx := middleware.GetAccountContext(r.Context())
	if authCtx == nil || authCtx.Session == nil {
		response.Unauthorized(w, "unauthorized")
		return
	}
	email := authCtx.Session.Email

	twoFA, _ := h.storage.GetTwoFA(email)
	keyring, _ := h.storage.GetKeyring(email)

	has2FA := twoFA != nil
	hasPGP := keyring != nil

	require2FA := true
	requirePGP := true
	if h.cfg != nil {
		require2FA = h.cfg.Require2FA
		requirePGP = h.cfg.RequirePGP
	}

	// completed：要求嘅部分全部已設；optional 部分就算未設都算完成
	completed := (!require2FA || has2FA) && (!requirePGP || hasPGP)

	response.Success(w, map[string]bool{
		"twoFAEnabled": has2FA,
		"pgpEnabled":   hasPGP,
		"require2FA":   require2FA,
		"requirePGP":   requirePGP,
		"completed":    completed,
	})
}

// EnsureJunkFolder 為指定帳號建立 Junk/spam 資料夾（若不存在）
func (h *AccountsHandler) EnsureJunkFolder(w http.ResponseWriter, r *http.Request) {
	authCtx := middleware.GetAccountContext(r.Context())
	if authCtx == nil || authCtx.Session == nil {
		response.Unauthorized(w, "unauthorized")
		return
	}
	id := chi.URLParam(r, "id")

	// 找出該帳號
	var acc *storage.Account
	for i := range authCtx.Session.Accounts {
		if authCtx.Session.Accounts[i].ID == id {
			acc = &authCtx.Session.Accounts[i]
			break
		}
	}
	if acc == nil {
		response.NotFound(w, "account not found")
		return
	}

	password := middleware.GetCurrentAccountPassword(authCtx, acc)
	imapCfg := imapinternal.ConnectionConfig{
		Host:             acc.IMAPHost,
		Port:             acc.IMAPPort,
		UseTLS:           acc.IMAPUseTLS,
		AllowInsecureTLS: acc.IMAPAllowInsecureTLS,
		Username:         acc.Username,
		Password:         password,
	}
	client, err := imapinternal.NewClient(imapCfg)
	if err != nil {
		response.InternalServerError(w, "failed to connect IMAP: "+err.Error())
		return
	}
	defer func() { _ = client.Close() }()

	// 搵現有 junk，或者建立 Junk
	junkFolder := ""
	if folders, err := client.ListFolders(r.Context()); err == nil {
		for _, f := range folders {
			if f.SpecialUse == "junk" || f.SpecialUse == "spam" || strings.Contains(strings.ToLower(f.Name), "junk") || strings.Contains(strings.ToLower(f.Name), "spam") {
				junkFolder = f.Name
				break
			}
		}
	}
	if junkFolder == "" {
		junkFolder, _ = client.EnsureFolder(r.Context(), "Junk")
	}

	response.Success(w, map[string]string{"junkFolder": junkFolder})
}

// GetFolderPrefs 取得帳號嘅 WebMail 專屬 folder 顯示偏好
func (h *AccountsHandler) GetFolderPrefs(w http.ResponseWriter, r *http.Request) {
	authCtx := middleware.GetAccountContext(r.Context())
	if authCtx == nil || authCtx.Session == nil {
		response.Unauthorized(w, "unauthorized")
		return
	}
	id := chi.URLParam(r, "id")
	prefs, err := h.storage.ListFolderPrefs(authCtx.Session.Email, id)
	if err != nil {
		response.InternalServerError(w, "failed to read folder prefs")
		return
	}
	response.Success(w, prefs)
}

// SetFolderPref 設定帳號嘅 WebMail 專屬 folder 顯示偏好（唔影響 IMAP subscription）
func (h *AccountsHandler) SetFolderPref(w http.ResponseWriter, r *http.Request) {
	authCtx := middleware.GetAccountContext(r.Context())
	if authCtx == nil || authCtx.Session == nil {
		response.Unauthorized(w, "unauthorized")
		return
	}
	id := chi.URLParam(r, "id")
	var req struct {
		Folder  string `json:"folder"`
		Visible bool   `json:"visible"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		response.BadRequest(w, "invalid json payload")
		return
	}
	if req.Folder == "" {
		response.BadRequest(w, "folder is required")
		return
	}
	if err := h.storage.SetFolderPref(authCtx.Session.Email, id, req.Folder, req.Visible); err != nil {
		response.InternalServerError(w, "failed to save folder pref")
		return
	}
	response.Success(w, map[string]bool{"visible": req.Visible})
}

// GetFolderOrder 取得帳號頂層 folder 顯示次序
func (h *AccountsHandler) GetFolderOrder(w http.ResponseWriter, r *http.Request) {
	authCtx := middleware.GetAccountContext(r.Context())
	if authCtx == nil || authCtx.Session == nil {
		response.Unauthorized(w, "unauthorized")
		return
	}
	id := chi.URLParam(r, "id")
	order, err := h.storage.GetFolderOrder(authCtx.Session.Email, id)
	if err != nil {
		response.InternalServerError(w, "failed to read folder order")
		return
	}
	if order == nil {
		order = []string{}
	}
	response.Success(w, order)
}

// SetFolderOrder 覆寫帳號頂層 folder 顯示次序
func (h *AccountsHandler) SetFolderOrder(w http.ResponseWriter, r *http.Request) {
	authCtx := middleware.GetAccountContext(r.Context())
	if authCtx == nil || authCtx.Session == nil {
		response.Unauthorized(w, "unauthorized")
		return
	}
	id := chi.URLParam(r, "id")
	var req struct {
		Order []string `json:"order"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		response.BadRequest(w, "invalid json payload")
		return
	}
	if err := h.storage.SetFolderOrder(authCtx.Session.Email, id, req.Order); err != nil {
		response.InternalServerError(w, "failed to save folder order")
		return
	}
	response.Success(w, map[string]bool{"saved": true})
}

// ListAccounts 列出所有帳號（不含密碼）
func (h *AccountsHandler) ListAccounts(w http.ResponseWriter, r *http.Request) {
	authCtx := middleware.GetAccountContext(r.Context())
	accounts := authCtx.Session.Accounts

	// 抽出明文（密碼欄位 json:"-" 唔會序列化）
	sanitized := make([]storage.Account, 0, len(accounts))
	for _, acc := range accounts {
		acc.EncIMAPPassword = ""
		acc.EncSMTPPassword = ""
		acc.UserEmail = ""
		sanitized = append(sanitized, acc)
	}
	response.Success(w, sanitized)
}

// CreateAccount 新增帳號
func (h *AccountsHandler) CreateAccount(w http.ResponseWriter, r *http.Request) {
	authCtx := middleware.GetAccountContext(r.Context())
	if authCtx == nil || authCtx.Session == nil {
		response.Unauthorized(w, "unauthorized")
		return
	}

	var req AccountRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		response.BadRequest(w, "invalid json payload: "+err.Error())
		return
	}
	if req.Email == "" || req.IMAPHost == "" || req.SMTPHost == "" || req.Password == "" {
		response.BadRequest(w, "email, imapHost, smtpHost, and password are required")
		return
	}
	if req.Username == "" {
		req.Username = req.Email
	}

	// 加密密碼
	imapEnc, err := crypto.Encrypt(authCtx.DEK, []byte(req.Password))
	if err != nil {
		response.InternalServerError(w, "failed to encrypt password")
		return
	}
	smtpEnc, err := crypto.Encrypt(authCtx.DEK, []byte(req.Password))
	if err != nil {
		response.InternalServerError(w, "failed to encrypt password")
		return
	}

	// 判斷是否為首個帳號
	count, err := h.storage.CountAccounts(authCtx.Session.Email)
	if err != nil {
		response.InternalServerError(w, "failed to count accounts")
		return
	}

	acc := &storage.Account{
		UserEmail:             authCtx.Session.Email,
		Label:                 req.Label,
		Email:                 req.Email,
		IMAPHost:              req.IMAPHost,
		IMAPPort:              req.IMAPPort,
		IMAPUseTLS:            req.IMAPUseTLS,
		IMAPAllowInsecureTLS:  req.IMAPAllowInsecureTLS,
		SMTPHost:              req.SMTPHost,
		SMTPPort:              req.SMTPPort,
		SMTPUseTLS:            req.SMTPUseTLS,
		SMTPAllowInsecureTLS:  req.SMTPAllowInsecureTLS,
		SieveHost:             req.SieveHost,
		SievePort:             req.SievePort,
		SieveUseTLS:           req.SieveUseTLS,
		SieveAllowInsecureTLS: req.SieveAllowInsecureTLS,
		Username:              req.Username,
		EncIMAPPassword:       imapEnc,
		EncSMTPPassword:       smtpEnc,
		IsDefault:             count == 0,
		SortOrder:             count,
	}
	if acc.Label == "" {
		acc.Label = acc.Email
	}
	if acc.IMAPPort <= 0 {
		acc.IMAPPort = 993
	}
	if acc.SMTPPort <= 0 {
		acc.SMTPPort = 587
	}
	if acc.SievePort < 0 {
		acc.SievePort = 0
	}
	if acc.SieveHost == "" && acc.SievePort == 0 && !acc.SieveUseTLS && !acc.SieveAllowInsecureTLS {
		acc.SieveUseTLS = true
	}

	if err := h.storage.CreateAccount(acc); err != nil {
		response.InternalServerError(w, "failed to create account: "+err.Error())
		return
	}

	h.refreshSessionAccounts(authCtx)

	response.Success(w, acc)
}

// UpdateAccount 編輯帳號（密碼可留空=不變）
func (h *AccountsHandler) UpdateAccount(w http.ResponseWriter, r *http.Request) {
	authCtx := middleware.GetAccountContext(r.Context())
	if authCtx == nil || authCtx.Session == nil {
		response.Unauthorized(w, "unauthorized")
		return
	}

	id := chi.URLParam(r, "id")
	existing, err := h.storage.GetAccount(authCtx.Session.Email, id)
	if err != nil {
		response.InternalServerError(w, "failed to get account")
		return
	}
	if existing == nil {
		response.NotFound(w, "account not found")
		return
	}

	var req AccountRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		response.BadRequest(w, "invalid json payload: "+err.Error())
		return
	}

	existing.Label = req.Label
	if existing.Label == "" {
		existing.Label = existing.Email
	}
	if req.Email != "" {
		existing.Email = req.Email
		existing.Label = req.Label
	}
	if req.IMAPHost != "" {
		existing.IMAPHost = req.IMAPHost
	}
	if req.IMAPPort > 0 {
		existing.IMAPPort = req.IMAPPort
	}
	if req.SMTPHost != "" {
		existing.SMTPHost = req.SMTPHost
	}
	if req.SMTPPort > 0 {
		existing.SMTPPort = req.SMTPPort
	}
	if req.Username != "" {
		existing.Username = req.Username
	}
	existing.IMAPUseTLS = req.IMAPUseTLS
	existing.IMAPAllowInsecureTLS = req.IMAPAllowInsecureTLS
	existing.SMTPUseTLS = req.SMTPUseTLS
	existing.SMTPAllowInsecureTLS = req.SMTPAllowInsecureTLS
	existing.SieveHost = req.SieveHost
	if req.SievePort >= 0 {
		existing.SievePort = req.SievePort
	}
	existing.SieveUseTLS = req.SieveUseTLS
	existing.SieveAllowInsecureTLS = req.SieveAllowInsecureTLS

	// 若提供密碼則更新加密
	if req.Password != "" {
		imapEnc, err := crypto.Encrypt(authCtx.DEK, []byte(req.Password))
		if err != nil {
			response.InternalServerError(w, "failed to encrypt password")
			return
		}
		smtpEnc, err := crypto.Encrypt(authCtx.DEK, []byte(req.Password))
		if err != nil {
			response.InternalServerError(w, "failed to encrypt password")
			return
		}
		existing.EncIMAPPassword = imapEnc
		existing.EncSMTPPassword = smtpEnc
	}

	if err := h.storage.UpdateAccount(existing); err != nil {
		response.InternalServerError(w, "failed to update account: "+err.Error())
		return
	}

	h.refreshSessionAccounts(authCtx)

	response.Success(w, map[string]bool{"updated": true})
}

// DeleteAccount 刪除帳號（不可刪除最後一個帳號）
func (h *AccountsHandler) DeleteAccount(w http.ResponseWriter, r *http.Request) {
	authCtx := middleware.GetAccountContext(r.Context())
	if authCtx == nil || authCtx.Session == nil {
		response.Unauthorized(w, "unauthorized")
		return
	}

	id := chi.URLParam(r, "id")
	if len(authCtx.Session.Accounts) <= 1 {
		response.BadRequest(w, "cannot delete the last account")
		return
	}

	if err := h.storage.DeleteAccount(authCtx.Session.Email, id); err != nil {
		response.InternalServerError(w, "failed to delete account: "+err.Error())
		return
	}

	h.idleMgr.StopListener(authCtx.Session.ID, id)
	h.poolMgr.DestroyPool(authCtx.Session.ID, id)
	h.refreshSessionAccounts(authCtx)

	response.Success(w, map[string]bool{"deleted": true})
}

// SetDefaultAccount 設為預設帳號
func (h *AccountsHandler) SetDefaultAccount(w http.ResponseWriter, r *http.Request) {
	authCtx := middleware.GetAccountContext(r.Context())
	if authCtx == nil || authCtx.Session == nil {
		response.Unauthorized(w, "unauthorized")
		return
	}

	id := chi.URLParam(r, "id")
	if err := h.storage.SetDefaultAccount(authCtx.Session.Email, id); err != nil {
		response.InternalServerError(w, "failed to set default account: "+err.Error())
		return
	}

	h.refreshSessionAccounts(authCtx)

	response.Success(w, map[string]bool{"isDefault": true})
}

// TestAccount 測試 IMAP/SMTP 連線
func (h *AccountsHandler) TestAccount(w http.ResponseWriter, r *http.Request) {
	var req AccountRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		response.BadRequest(w, "invalid json payload")
		return
	}
	if req.IMAPHost == "" || req.SMTPHost == "" {
		response.BadRequest(w, "imapHost and smtpHost are required")
		return
	}
	if req.Username == "" {
		req.Username = req.Email
	}
	if req.IMAPPort <= 0 {
		req.IMAPPort = 993
	}
	if req.SMTPPort <= 0 {
		req.SMTPPort = 587
	}

	imapOK := "failed"
	smtpOK := "failed"

	// 測試 IMAP
	imapCfg := imapinternal.ConnectionConfig{
		Host:             req.IMAPHost,
		Port:             req.IMAPPort,
		UseTLS:           req.IMAPUseTLS,
		AllowInsecureTLS: req.IMAPAllowInsecureTLS,
		Username:         req.Username,
		Password:         req.Password,
	}
	if _, err := imapinternal.NewClient(imapCfg); err == nil {
		imapOK = "ok"
	}

	// 測試 SMTP（只測連線 + 認證）
	smtpCfg := smtp.SMTPConfig{
		Host:             req.SMTPHost,
		Port:             req.SMTPPort,
		UseTLS:           req.SMTPUseTLS,
		AllowInsecureTLS: req.SMTPAllowInsecureTLS,
		Username:         req.Username,
		Password:         req.Password,
	}
	if err := smtp.TestSMTPConnection(r.Context(), smtpCfg); err == nil {
		smtpOK = "ok"
	}

	response.Success(w, map[string]string{
		"imap": imapOK,
		"smtp": smtpOK,
	})
}

// refreshSessionAccounts 更新 session 內嘅 accounts list（用 DB 資料，維持加密）
func (h *AccountsHandler) refreshSessionAccounts(authCtx *middleware.AuthContext) {
	if authCtx == nil || authCtx.Session == nil {
		return
	}
	accounts, err := h.storage.ListAccounts(authCtx.Session.Email)
	if err != nil {
		log.Printf("[ACCOUNTS] failed to reload accounts: %v", err)
		return
	}
	authCtx.Session.Accounts = accounts

	// 更新 authCtx 密碼 map（用 DEK 解密最新密碼）
	newPasswords := make(map[string]string, len(accounts))
	for i := range accounts {
		if imapPass, err := crypto.Decrypt(authCtx.DEK, accounts[i].EncIMAPPassword); err == nil {
			newPasswords[accounts[i].ID] = string(imapPass)
		}
	}
	authCtx.Passwords = newPasswords
}
