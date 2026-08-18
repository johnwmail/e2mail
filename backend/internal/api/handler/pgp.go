package handler

import (
	"encoding/json"
	"net/http"

	"modern-webmail/backend/internal/api/middleware"
	"modern-webmail/backend/internal/storage"
	"modern-webmail/backend/pkg/response"
)

// PGPHandler 處理個人 PGP 雲端金鑰包之備份與跨裝置同步（儲存於 SQLite）
type PGPHandler struct {
	store storage.Store
}

// NewPGPHandler 初始化 PGPHandler
func NewPGPHandler(store storage.Store) *PGPHandler {
	return &PGPHandler{store: store}
}

// SaveKeyring 儲存或更新使用者的加密金鑰包
func (h *PGPHandler) SaveKeyring(w http.ResponseWriter, r *http.Request) {
	sess, ok := middleware.GetSessionFromContext(r.Context())
	if !ok || sess.Email == "" {
		response.Unauthorized(w, "unauthorized session")
		return
	}

	var req storage.Keyring
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		response.BadRequest(w, "invalid json body: "+err.Error())
		return
	}

	if req.EncryptedPrivateKeyArmored == "" || req.PublicKeyArmored == "" {
		response.BadRequest(w, "publicKeyArmored and encryptedPrivateKeyArmored are required")
		return
	}

	req.Email = sess.Email
	if err := h.store.SaveKeyring(&req); err != nil {
		response.InternalServerError(w, "failed to persist keyring: "+err.Error())
		return
	}

	response.Success(w, map[string]interface{}{
		"message":   "encrypted keyring synced successfully",
		"updatedAt": req.UpdatedAt,
	})
}

// GetKeyring 取得使用者的加密金鑰包（若無則回傳空）
func (h *PGPHandler) GetKeyring(w http.ResponseWriter, r *http.Request) {
	sess, ok := middleware.GetSessionFromContext(r.Context())
	if !ok || sess.Email == "" {
		response.Unauthorized(w, "unauthorized session")
		return
	}

	payload, err := h.store.GetKeyring(sess.Email)
	if err != nil {
		response.InternalServerError(w, "failed to read keyring: "+err.Error())
		return
	}
	if payload == nil {
		response.Success(w, nil)
		return
	}
	response.Success(w, payload)
}

// DeleteKeyring 刪除使用者的雲端金鑰包
func (h *PGPHandler) DeleteKeyring(w http.ResponseWriter, r *http.Request) {
	sess, ok := middleware.GetSessionFromContext(r.Context())
	if !ok || sess.Email == "" {
		response.Unauthorized(w, "unauthorized session")
		return
	}

	if err := h.store.DeleteKeyring(sess.Email); err != nil {
		response.InternalServerError(w, "failed to delete keyring: "+err.Error())
		return
	}

	response.Success(w, map[string]string{
		"message": "cloud keyring deleted successfully",
	})
}
