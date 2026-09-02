package config

import (
	"os"
	"strconv"
	"strings"
)

// ServerConfig 由環境變數載入的伺服器預設值，作為登入頁面之預填與強制預設
type ServerConfig struct {
	DefaultIMAPHost         string
	DefaultIMAPPort         int
	DefaultSMTPHost         string
	DefaultSMTPPort         int
	DefaultAllowInsecureTLS bool
	CookieSecure            bool
	Require2FA              bool
	RequirePGP              bool
	LDAP                    *LDAPConfig
}

// LDAPConfig OpenBSD ldapd 連接設定（僅用於變更密碼；登入仍為 IMAP bind）。
// 文檔見 repo 根目錄 LDAP.md。
type LDAPConfig struct {
	Enabled          bool
	URL              string // ldaps://host:636 或 ldap://host:389（配 StartTLS）
	StartTLS         bool   // ldap:// URL 上以 STARTTLS 升級
	RootDN           string // 服務帳號（ldapd namespace rootdn）
	RootPW           string // 服務帳號密碼 —— 只由 env/secret 注入，永不 log
	UserDNTemplate   string // 例 "uid=%s,ou=people,dc=example,dc=com"；%s=全 email，%u=local part
	PasswordScheme   string // v1 僅 "ssha"
	AllowInsecureTLS bool   // 自簽憑證（僅開發，跳過校驗）
	CAFile           string // 自簽 RootCA 路徑（例 /certs/rootCA.crt）；有值時用佢做信任庫
}

// Ready 判斷 LDAP 變更密碼是否配置完整可用（nil-safe）
func (l *LDAPConfig) Ready() bool {
	return l != nil && l.Enabled &&
		l.URL != "" && l.RootDN != "" && l.RootPW != "" && l.UserDNTemplate != ""
}

// Load 從環境變數載入設定；未設定的欄位採用安全預設值（IMAP 993 / SMTP 587 / 不容許自簽）
func Load() *ServerConfig {
	cfg := &ServerConfig{
		DefaultIMAPPort:         993,
		DefaultSMTPPort:         587,
		DefaultAllowInsecureTLS: false,
		CookieSecure:            true,
		Require2FA:              true,
		RequirePGP:              true,
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
	if v := os.Getenv("COOKIE_SECURE"); v != "" {
		cfg.CookieSecure = parseBool(v)
	}
	if v := os.Getenv("REQUIRE_2FA"); v != "" {
		cfg.Require2FA = parseBool(v)
	}
	if v := os.Getenv("REQUIRE_PGP"); v != "" {
		cfg.RequirePGP = parseBool(v)
	}

	cfg.LDAP = loadLDAP()
	return cfg
}

// loadLDAP 由 LDAP_* 環境變數載入變更密碼設定（未設定即 Enabled=false）
func loadLDAP() *LDAPConfig {
	l := &LDAPConfig{PasswordScheme: "ssha"}
	if v := os.Getenv("LDAP_ENABLED"); v != "" {
		l.Enabled = parseBool(v)
	}
	if v := os.Getenv("LDAP_URL"); v != "" {
		l.URL = v
	}
	if v := os.Getenv("LDAP_STARTTLS"); v != "" {
		l.StartTLS = parseBool(v)
	}
	l.RootDN = os.Getenv("LDAP_ROOT_DN")
	l.RootPW = os.Getenv("LDAP_ROOT_PW")
	l.UserDNTemplate = os.Getenv("LDAP_USER_DN_TEMPLATE")
	if v := os.Getenv("LDAP_PASSWORD_SCHEME"); v != "" {
		l.PasswordScheme = strings.ToLower(v)
	}
	if v := os.Getenv("LDAP_ALLOW_INSECURE_TLS"); v != "" {
		l.AllowInsecureTLS = parseBool(v)
	}
	if v := os.Getenv("LDAP_CA_FILE"); v != "" {
		l.CAFile = v
	} else if v := os.Getenv("LDAP_CA_CRT"); v != "" {
		l.CAFile = v
	}
	return l
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
