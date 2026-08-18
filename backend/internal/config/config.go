package config

import (
	"os"
	"strconv"
)

// ServerConfig 由環境變數載入的伺服器預設值，作為登入頁面之預填與強制預設
type ServerConfig struct {
	DefaultIMAPHost         string
	DefaultIMAPPort         int
	DefaultSMTPHost         string
	DefaultSMTPPort         int
	DefaultAllowInsecureTLS bool
}

// Load 從環境變數載入設定；未設定的欄位採用安全預設值（IMAP 993 / SMTP 587 / 不容許自簽）
func Load() *ServerConfig {
	cfg := &ServerConfig{
		DefaultIMAPPort:         993,
		DefaultSMTPPort:         587,
		DefaultAllowInsecureTLS: false,
	}
	if v := os.Getenv("DEFAULT_IMAP_HOST"); v != "" {
		cfg.DefaultIMAPHost = v
	}
	if v := os.Getenv("DEFAULT_IMAP_PORT"); v != "" {
		if port, err := strconv.Atoi(v); err == nil && port > 0 {
			cfg.DefaultIMAPPort = port
		}
	}
	if v := os.Getenv("DEFAULT_SMTP_HOST"); v != "" {
		cfg.DefaultSMTPHost = v
	}
	if v := os.Getenv("DEFAULT_SMTP_PORT"); v != "" {
		if port, err := strconv.Atoi(v); err == nil && port > 0 {
			cfg.DefaultSMTPPort = port
		}
	}
	if v := os.Getenv("DEFAULT_ALLOW_INSECURE_TLS"); v != "" {
		cfg.DefaultAllowInsecureTLS = parseBool(v)
	}
	return cfg
}

// HasDefaults 是否至少設定了一個主機（用以判斷要不要回傳給前端）
func (c *ServerConfig) HasDefaults() bool {
	return c.DefaultIMAPHost != "" || c.DefaultSMTPHost != ""
}

func parseBool(s string) bool {
	switch s {
	case "1", "true", "TRUE", "True", "yes", "YES", "on", "ON":
		return true
	default:
		return false
	}
}
