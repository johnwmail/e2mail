package handler

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-webauthn/webauthn/webauthn"

	"github.com/johnwmail/e2mail/backend/internal/api/middleware"
	"github.com/johnwmail/e2mail/backend/internal/auth"
	"github.com/johnwmail/e2mail/backend/internal/storage"
	"github.com/johnwmail/e2mail/backend/pkg/response"
)

const (
	webauthnMaxFailures = 8
	webauthnFailWindow  = 10 * time.Minute
	maxPasskeyNameLen   = 64
)

// webAuthnCredentialDTO 回傳前端嘅 passkey 摘要（唔含 public key）
type webAuthnCredentialDTO struct {
	ID         string    `json:"id"`
	Name       string    `json:"name,omitempty"`
	CreatedAt  time.Time `json:"createdAt"`
	LastUsedAt time.Time `json:"lastUsedAt"`
	Transports []string  `json:"transports,omitempty"`
	AAGUID     string    `json:"aaguid,omitempty"`
}

// webAuthnBeginResponse Begin* 端點回應：ceremony challenge id + WebAuthn options
type webAuthnBeginResponse struct {
	Challenge string `json:"challenge"`
	PublicKey any    `json:"publicKey"`
}

func webauthnIDString(cred *webauthn.Credential) string {
	return base64.RawURLEncoding.EncodeToString(cred.ID)
}

// secondFactorMethods 回傳該帳號可用嘅第二因素方法清單（每個方法獨立開關）
func secondFactorMethods(totp, passkey bool) []string {
	methods := make([]string, 0, 2)
	if totp {
		methods = append(methods, "totp")
	}
	if passkey {
		methods = append(methods, "webauthn")
	}
	return methods
}

// loadWebAuthnUser 由 storage 讀取使用者憑證並組成 webauthn.User（credential JSON 損壞則略過）
func (h *AuthHandler) loadWebAuthnUser(email string) (*auth.WebAuthnUser, error) {
	stored, err := h.storage.ListWebAuthnCredentials(email)
	if err != nil {
		return nil, err
	}
	creds := make([]webauthn.Credential, 0, len(stored))
	for _, s := range stored {
		cred, err := auth.ParseCredential(s.CredentialJSON)
		if err != nil {
			log.Printf("[WEBAUTHN] skipping corrupt credential %s for %s: %v", s.CredentialID, email, err)
			continue
		}
		creds = append(creds, *cred)
	}
	return auth.NewWebAuthnUser(email, creds), nil
}

func (h *AuthHandler) webauthnBlocked(w http.ResponseWriter, r *http.Request, email string) bool {
	if h.pwLimiter.Blocked("webauthn:ip:"+requestIP(r), webauthnMaxFailures, webauthnFailWindow) ||
		(email != "" && h.pwLimiter.Blocked("webauthn:email:"+normalizeEmail(email), webauthnMaxFailures, webauthnFailWindow)) {
		response.Error(w, http.StatusTooManyRequests, "too many failed passkey attempts, try again later")
		return true
	}
	return false
}

func (h *AuthHandler) recordWebAuthnFailure(r *http.Request, email string) {
	h.pwLimiter.RecordFailure("webauthn:ip:" + requestIP(r))
	if email != "" {
		h.pwLimiter.RecordFailure("webauthn:email:" + normalizeEmail(email))
	}
}

func (h *AuthHandler) resetWebAuthnFailures(r *http.Request, email string) {
	h.pwLimiter.Reset("webauthn:ip:" + requestIP(r))
	if email != "" {
		h.pwLimiter.Reset("webauthn:email:" + normalizeEmail(email))
	}
}

// WebAuthnList 列出目前已登入使用者嘅所有 passkey
func (h *AuthHandler) WebAuthnList(w http.ResponseWriter, r *http.Request) {
	sess, ok := middleware.GetSessionFromContext(r.Context())
	if !ok || sess == nil {
		response.Unauthorized(w, "unauthorized")
		return
	}
	stored, err := h.storage.ListWebAuthnCredentials(normalizeEmail(sess.Email))
	if err != nil {
		response.InternalServerError(w, "failed to load passkeys")
		return
	}
	out := make([]webAuthnCredentialDTO, 0, len(stored))
	for _, s := range stored {
		out = append(out, toWebAuthnDTO(s))
	}
	response.Success(w, map[string]any{"credentials": out})
}

func toWebAuthnDTO(s storage.WebAuthnCredential) webAuthnCredentialDTO {
	dto := webAuthnCredentialDTO{
		ID:         s.CredentialID,
		Name:       s.Name,
		CreatedAt:  s.CreatedAt,
		LastUsedAt: s.LastUsedAt,
	}
	if cred, err := auth.ParseCredential(s.CredentialJSON); err == nil {
		for _, t := range cred.Transport {
			dto.Transports = append(dto.Transports, string(t))
		}
		if len(cred.Authenticator.AAGUID) > 0 {
			dto.AAGUID = base64.RawURLEncoding.EncodeToString(cred.Authenticator.AAGUID)
		}
	}
	return dto
}

// WebAuthnRegisterBegin 開始註冊一個新 passkey，回傳 creation options 同 ceremony challenge id
func (h *AuthHandler) WebAuthnRegisterBegin(w http.ResponseWriter, r *http.Request) {
	sess, ok := middleware.GetSessionFromContext(r.Context())
	if !ok || sess == nil {
		response.Unauthorized(w, "unauthorized")
		return
	}
	if !h.webauthnReady() {
		response.Forbidden(w, "passkey support is not enabled on this server")
		return
	}

	user, err := h.loadWebAuthnUser(normalizeEmail(sess.Email))
	if err != nil {
		response.InternalServerError(w, "failed to load passkeys")
		return
	}

	creation, challengeID, err := h.webauthn.BeginRegistration(user)
	if err != nil {
		log.Printf("[WEBAUTHN] begin registration failed for %s: %v", sess.Email, err)
		response.InternalServerError(w, "failed to start passkey registration")
		return
	}
	response.Success(w, webAuthnBeginResponse{Challenge: challengeID, PublicKey: creation.Response})
}

// WebAuthnRegisterFinish 驗證 attestation 並儲存新 passkey。
// Body 為 raw RegistrationResponseJSON；ceremony challenge id 由 ?challenge= 帶入，
// 顯示名由 ?name= 帶入（可省略）。
func (h *AuthHandler) WebAuthnRegisterFinish(w http.ResponseWriter, r *http.Request) {
	sess, ok := middleware.GetSessionFromContext(r.Context())
	if !ok || sess == nil {
		response.Unauthorized(w, "unauthorized")
		return
	}
	if !h.webauthnReady() {
		response.Forbidden(w, "passkey support is not enabled on this server")
		return
	}
	challengeID := r.URL.Query().Get("challenge")
	if challengeID == "" {
		response.BadRequest(w, "challenge is required")
		return
	}

	user, err := h.loadWebAuthnUser(normalizeEmail(sess.Email))
	if err != nil {
		response.InternalServerError(w, "failed to load passkeys")
		return
	}

	credential, err := h.webauthn.FinishRegistration(user, challengeID, r)
	if err != nil {
		log.Printf("[WEBAUTHN] finish registration failed for %s: %v", sess.Email, err)
		response.BadRequest(w, "passkey registration failed")
		return
	}

	credJSON, err := auth.MarshalCredential(credential)
	if err != nil {
		response.InternalServerError(w, "failed to store passkey")
		return
	}

	name := trimPasskeyName(r.URL.Query().Get("name"))
	if name == "" {
		name = defaultPasskeyName(credential)
	}

	rec := &storage.WebAuthnCredential{
		OwnerEmail:     normalizeEmail(sess.Email),
		CredentialID:   webauthnIDString(credential),
		Name:           name,
		CredentialJSON: credJSON,
	}
	if err := h.storage.CreateWebAuthnCredential(rec); err != nil {
		log.Printf("[WEBAUTHN] save credential failed for %s: %v", sess.Email, err)
		response.InternalServerError(w, "failed to store passkey")
		return
	}

	log.Printf("[WEBAUTHN] registered passkey for %s (%s)", sess.Email, rec.CredentialID)
	response.Success(w, toWebAuthnDTO(*rec))
}

// defaultPasskeyName 依 authenticator attachment 產生預設名
func defaultPasskeyName(cred *webauthn.Credential) string {
	switch string(cred.Authenticator.Attachment) {
	case "platform":
		return "This device"
	case "cross-platform":
		return "Security key"
	default:
		return "Passkey"
	}
}

// WebAuthnRename 更新 passkey 顯示名
func (h *AuthHandler) WebAuthnRename(w http.ResponseWriter, r *http.Request) {
	sess, ok := middleware.GetSessionFromContext(r.Context())
	if !ok || sess == nil {
		response.Unauthorized(w, "unauthorized")
		return
	}
	credID := chi.URLParam(r, "id")
	if credID == "" {
		response.BadRequest(w, "credential id is required")
		return
	}
	var body struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		response.BadRequest(w, "invalid request body format")
		return
	}
	name := trimPasskeyName(body.Name)
	if name == "" {
		response.BadRequest(w, "name is required")
		return
	}
	if err := h.storage.RenameWebAuthnCredential(normalizeEmail(sess.Email), credID, name); err != nil {
		if errors.Is(err, storage.ErrWebAuthnNotFound) {
			response.Error(w, http.StatusNotFound, "passkey not found")
			return
		}
		response.InternalServerError(w, "failed to rename passkey")
		return
	}
	response.Success(w, map[string]bool{"renamed": true})
}

// WebAuthnDelete 刪除指定 passkey
func (h *AuthHandler) WebAuthnDelete(w http.ResponseWriter, r *http.Request) {
	sess, ok := middleware.GetSessionFromContext(r.Context())
	if !ok || sess == nil {
		response.Unauthorized(w, "unauthorized")
		return
	}
	credID := chi.URLParam(r, "id")
	if credID == "" {
		response.BadRequest(w, "credential id is required")
		return
	}
	n, err := h.storage.DeleteWebAuthnCredential(normalizeEmail(sess.Email), credID)
	if err != nil {
		response.InternalServerError(w, "failed to delete passkey")
		return
	}
	if n == 0 {
		response.Error(w, http.StatusNotFound, "passkey not found")
		return
	}
	log.Printf("[WEBAUTHN] deleted passkey for %s (%s)", sess.Email, credID)
	response.Success(w, map[string]bool{"deleted": true})
}

// ===== 登入第二階段 =====
// WebAuthnLoginBegin 開始 assertion ceremony。Body: {"challenge": "<pending login id>"}。
// 回傳 ceremony challenge id 同 assertion options。
func (h *AuthHandler) WebAuthnLoginBegin(w http.ResponseWriter, r *http.Request) {
	if !h.webauthnReady() {
		response.Forbidden(w, "passkey support is not enabled on this server")
		return
	}
	var body struct {
		Challenge string `json:"challenge"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Challenge == "" {
		response.BadRequest(w, "challenge is required")
		return
	}

	pl := h.pendingLogin.Get(body.Challenge)
	if pl == nil {
		response.Unauthorized(w, "驗證已逾時或無效，請重新登入")
		return
	}
	if h.webauthnBlocked(w, r, pl.Email) {
		return
	}

	user, err := h.loadWebAuthnUser(normalizeEmail(pl.Email))
	if err != nil {
		response.InternalServerError(w, "failed to load passkeys")
		return
	}

	assertion, ceremonyID, err := h.webauthn.BeginLogin(user, body.Challenge)
	if err != nil {
		log.Printf("[WEBAUTHN] begin login failed for %s: %v", pl.Email, err)
		response.BadRequest(w, "passkey login failed")
		return
	}
	response.Success(w, webAuthnBeginResponse{Challenge: ceremonyID, PublicKey: assertion.Response})
}

// WebAuthnLoginVerify 驗證 assertion 並完成登入。
// Body 為 raw AssertionJSON；ceremony challenge id 由 ?challenge= 帶入。
func (h *AuthHandler) WebAuthnLoginVerify(w http.ResponseWriter, r *http.Request) {
	if !h.webauthnReady() {
		response.Forbidden(w, "passkey support is not enabled on this server")
		return
	}
	ceremonyID := r.URL.Query().Get("challenge")
	if ceremonyID == "" {
		response.BadRequest(w, "challenge is required")
		return
	}
	pendingID, ok := h.webauthn.PeekLoginPayload(ceremonyID)
	if !ok || pendingID == "" {
		response.Unauthorized(w, "驗證已逾時或無效，請重新登入")
		return
	}
	pl := h.pendingLogin.Get(pendingID)
	if pl == nil {
		response.Unauthorized(w, "驗證已逾時或無效，請重新登入")
		return
	}
	if h.webauthnBlocked(w, r, pl.Email) {
		return
	}

	user, err := h.loadWebAuthnUser(normalizeEmail(pl.Email))
	if err != nil {
		response.InternalServerError(w, "failed to load passkeys")
		return
	}

	credential, _, err := h.webauthn.FinishLogin(user, ceremonyID, r)
	if err != nil {
		log.Printf("[WEBAUTHN] finish login failed for %s: %v", pl.Email, err)
		h.recordWebAuthnFailure(r, pl.Email)
		response.Unauthorized(w, "passkey verification failed")
		return
	}

	// 回寫更新後嘅 credential（sign count 遞增、flags/backup state）
	if credJSON, mErr := auth.MarshalCredential(credential); mErr == nil {
		if uErr := h.storage.UpdateWebAuthnCredential(normalizeEmail(pl.Email), webauthnIDString(credential), credJSON); uErr != nil {
			log.Printf("[WEBAUTHN] update credential failed for %s: %v", pl.Email, uErr)
		}
	}

	h.resetWebAuthnFailures(r, pl.Email)
	h.completeLogin(w, r, pl, pendingID)
}

// trimPasskeyName 清理 passkey 顯示名（trim + 截斷）
func trimPasskeyName(name string) string {
	name = strings.TrimSpace(name)
	if len(name) > maxPasskeyNameLen {
		name = name[:maxPasskeyNameLen]
	}
	return name
}
