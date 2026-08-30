package handler

import (
	"encoding/base32"
	"encoding/json"
	"log"
	"net/http"
	"strings"

	"github.com/johnwmail/e2mail/backend/internal/api/middleware"
	"github.com/johnwmail/e2mail/backend/internal/auth"
	"github.com/johnwmail/e2mail/backend/internal/crypto"
	"github.com/johnwmail/e2mail/backend/internal/storage"
	"github.com/johnwmail/e2mail/backend/pkg/response"
)

// TwoFAStatusResponse 2FA 狀態回應
type TwoFAStatusResponse struct {
	Enabled bool `json:"enabled"`
}

// TwoFASetupRequest 自訂 secret（選填，用於沿用舊 2FA）
type TwoFASetupRequest struct {
	Secret string `json:"secret,omitempty"`
}

// TwoFASetupResponse setup 回應（包含 secret 與 otpauth URI）
type TwoFASetupResponse struct {
	Secret     string `json:"secret"`
	OTPAuthURL string `json:"otpauthUrl"`
	Issuer     string `json:"issuer"`
	Account    string `json:"account"`
}

// TwoFAEnableRequest 啟用 2FA 請求
type TwoFAEnableRequest struct {
	Secret string `json:"secret"`
	Code   string `json:"code"`
}

// TwoFARegenerateRequest 重新生成備份碼請求
type TwoFARegenerateRequest struct {
	Code string `json:"code"`
}

// TwoFARegenerateResponse 重新生成備份碼回應
type TwoFARegenerateResponse struct {
	BackupCodes []string `json:"backupCodes"`
}

// TwoFAStatus 取得目前使用者的 2FA 狀態
func (h *AuthHandler) TwoFAStatus(w http.ResponseWriter, r *http.Request) {
	sess, ok := middleware.GetSessionFromContext(r.Context())
	if !ok || sess == nil {
		response.Unauthorized(w, "unauthorized")
		return
	}

	twoFA, err := h.storage.GetTwoFA(normalizeEmail(sess.Email))
	if err != nil {
		response.InternalServerError(w, "failed to load 2FA settings")
		return
	}

	response.Success(w, TwoFAStatusResponse{Enabled: twoFA != nil})
}

// TwoFASetup 生成新的 TOTP secret 與 otpauth URI（尚未啟用，等待 verify）
// 支援自訂 secret（用於沿用舊 MYOLD2FA...），若提供則沿用，否則隨機產生
func (h *AuthHandler) TwoFASetup(w http.ResponseWriter, r *http.Request) {
	sess, ok := middleware.GetSessionFromContext(r.Context())
	if !ok || sess == nil {
		response.Unauthorized(w, "unauthorized")
		return
	}

	// 已啟用就拒絕重複 setup
	existing, err := h.storage.GetTwoFA(normalizeEmail(sess.Email))
	if err != nil {
		response.InternalServerError(w, "failed to load 2FA settings")
		return
	}
	if existing != nil {
		response.BadRequest(w, "兩步驟驗證已啟用，請先停用後再重新設定")
		return
	}

	// 支援自訂 secret（沿用舊 2FA）
	var setupReq TwoFASetupRequest
	_ = json.NewDecoder(r.Body).Decode(&setupReq) // body 可為空，忽略錯誤以兼容舊客戶端
	secret := ""
	if s := normalizeSecret(setupReq.Secret); s != "" {
		if err := validateSecret(s); err != nil {
			response.BadRequest(w, err.Error())
			return
		}
		secret = s
	} else {
		secret = auth.GenerateSecret()
	}
	key, err := auth.GenerateKey(sess.Email, secret)
	if err != nil {
		response.InternalServerError(w, "failed to generate TOTP key")
		return
	}

	response.Success(w, TwoFASetupResponse{
		Secret:     secret,
		OTPAuthURL: key.URL(),
		Issuer:     auth.Issuer,
		Account:    sess.Email,
	})
}

// TwoFAEnable 使用 setup 產生的 secret 啟用 2FA（需驗證一次 code 確保已正確加入 authenticator）
func (h *AuthHandler) TwoFAEnable(w http.ResponseWriter, r *http.Request) {
	sess, ok := middleware.GetSessionFromContext(r.Context())
	if !ok || sess == nil {
		response.Unauthorized(w, "unauthorized")
		return
	}

	var req TwoFAEnableRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		response.BadRequest(w, "invalid request body format")
		return
	}

	if req.Secret == "" || req.Code == "" {
		response.BadRequest(w, "secret and code are required")
		return
	}

	if !auth.ValidateCode(req.Secret, req.Code) {
		response.Unauthorized(w, "驗證碼錯誤，請確認 Authenticator App 顯示的 6 位數碼")
		return
	}

	plainCodes, hashedCodes := auth.GenerateBackupCodes()

	// 用 session 內 DEK 加密 TOTP secret（zero-knowledge at rest，唔靠 server key）
	encSecret := req.Secret
	if authCtx := middleware.GetAccountContext(r.Context()); authCtx != nil && len(authCtx.DEK) > 0 {
		if enc, err := crypto.Encrypt(authCtx.DEK, []byte(req.Secret)); err == nil {
			encSecret = enc
		}
	}

	twoFA := &storage.TwoFA{
		OwnerEmail:   normalizeEmail(sess.Email),
		Secret:       encSecret,
		BackupHashes: hashedCodes,
	}
	if err := h.storage.SaveTwoFA(twoFA); err != nil {
		log.Printf("[2FA ERROR] failed to enable 2FA for %s: %v", sess.Email, err)
		response.InternalServerError(w, "failed to save 2FA settings")
		return
	}

	log.Printf("[2FA] Enabled two-step verification for %s", sess.Email)
	response.Success(w, map[string]interface{}{
		"enabled":     true,
		"backupCodes": plainCodes,
	})
}

// decryptTwoFASecret 用 session 內 DEK 解密 2FA secret（backward compat：解密失敗保留原值）
func decryptTwoFASecret(r *http.Request, twoFA *storage.TwoFA) string {
	if twoFA == nil {
		return ""
	}
	if authCtx := middleware.GetAccountContext(r.Context()); authCtx != nil && len(authCtx.DEK) > 0 {
		if dec, err := crypto.Decrypt(authCtx.DEK, twoFA.Secret); err == nil {
			return string(dec)
		}
	}
	return twoFA.Secret
}

// TwoFADisable 停用 2FA（需驗證 code）
func (h *AuthHandler) TwoFADisable(w http.ResponseWriter, r *http.Request) {
	sess, ok := middleware.GetSessionFromContext(r.Context())
	if !ok || sess == nil {
		response.Unauthorized(w, "unauthorized")
		return
	}

	var req TwoFAEnableRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		response.BadRequest(w, "invalid request body format")
		return
	}

	email := normalizeEmail(sess.Email)
	twoFA, err := h.storage.GetTwoFA(email)
	if err != nil {
		response.InternalServerError(w, "failed to load 2FA settings")
		return
	}
	if twoFA == nil {
		response.BadRequest(w, "兩步驟驗證未啟用")
		return
	}

	if !auth.ValidateCode(decryptTwoFASecret(r, twoFA), req.Code) {
		response.Unauthorized(w, "驗證碼錯誤，請重試")
		return
	}

	if err := h.storage.DeleteTwoFA(email); err != nil {
		log.Printf("[2FA ERROR] failed to disable 2FA for %s: %v", sess.Email, err)
		response.InternalServerError(w, "failed to delete 2FA settings")
		return
	}

	log.Printf("[2FA] Disabled two-step verification for %s", sess.Email)
	response.Success(w, map[string]bool{"enabled": false})
}

// TwoFARegenerateBackupCodes 重新生成備份碼（需驗證 code，舊碼即時作廢）
func (h *AuthHandler) TwoFARegenerateBackupCodes(w http.ResponseWriter, r *http.Request) {
	sess, ok := middleware.GetSessionFromContext(r.Context())
	if !ok || sess == nil {
		response.Unauthorized(w, "unauthorized")
		return
	}

	var req TwoFARegenerateRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		response.BadRequest(w, "invalid request body format")
		return
	}

	email := normalizeEmail(sess.Email)
	twoFA, err := h.storage.GetTwoFA(email)
	if err != nil {
		response.InternalServerError(w, "failed to load 2FA settings")
		return
	}
	if twoFA == nil {
		response.BadRequest(w, "兩步驟驗證未啟用")
		return
	}

	if !auth.ValidateCode(decryptTwoFASecret(r, twoFA), req.Code) {
		response.Unauthorized(w, "驗證碼錯誤，請重試")
		return
	}

	plainCodes, hashedCodes := auth.GenerateBackupCodes()
	twoFA.BackupHashes = hashedCodes
	if err := h.storage.SaveTwoFA(twoFA); err != nil {
		response.InternalServerError(w, "failed to save backup codes")
		return
	}

	log.Printf("[2FA] Regenerated backup codes for %s", sess.Email)
	response.Success(w, TwoFARegenerateResponse{BackupCodes: plainCodes})
}

func normalizeSecret(s string) string {
	s = strings.ToUpper(strings.TrimSpace(s))
	s = strings.ReplaceAll(s, " ", "")
	s = strings.ReplaceAll(s, "-", "")
	return strings.TrimRight(s, "=")
}

func validateSecret(s string) error {
	if len(s) < 16 {
		return validationError("secret 太短，至少 16 個 base32 字元（A-Z2-7）")
	}
	if len(s) > 64 {
		return validationError("secret 太長，最多 64 個字元")
	}
	for _, c := range s {
		if (c < 'A' || c > 'Z') && (c < '2' || c > '7') {
			return validationError("secret 只能包含 A-Z2-7（base32）")
		}
	}
	if _, err := base32.StdEncoding.WithPadding(base32.NoPadding).DecodeString(s); err != nil {
		return validationError("無效的 base32 secret: " + err.Error())
	}
	return nil
}