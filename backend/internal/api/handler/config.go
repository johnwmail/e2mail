package handler

import (
	"net/http"

	"modern-webmail/backend/internal/config"
	"modern-webmail/backend/pkg/response"
)

// ServerConfigHandler 對外公開伺服器預設值（無需認證，登入頁面用以預填表單）
type ServerConfigHandler struct {
	cfg *config.ServerConfig
}

// NewServerConfigHandler 初始化 ServerConfigHandler
func NewServerConfigHandler(cfg *config.ServerConfig) *ServerConfigHandler {
	return &ServerConfigHandler{cfg: cfg}
}

// Get 取得伺服器預設 IMAP / SMTP 設定同 onboarding require flags（公開端點）
func (h *ServerConfigHandler) Get(w http.ResponseWriter, r *http.Request) {
	resp := map[string]any{
		"require2fa":  h.cfg.Require2FA,
		"requirePgp":  h.cfg.RequirePGP,
		"defaults":    nil,
	}
	if h.cfg != nil && h.cfg.HasDefaults() {
		resp["defaults"] = map[string]any{
			"imapHost":         h.cfg.DefaultIMAPHost,
			"imapPort":         h.cfg.DefaultIMAPPort,
			"smtpHost":         h.cfg.DefaultSMTPHost,
			"smtpPort":         h.cfg.DefaultSMTPPort,
			"allowInsecureTls": h.cfg.DefaultAllowInsecureTLS,
		}
	}
	response.Success(w, resp)
}
