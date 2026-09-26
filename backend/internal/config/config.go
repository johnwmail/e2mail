package config

import (
	"log"
	"os"
	"strconv"
	"strings"
)

// ServerConfig 由環境變數載入的伺服器預設值，作為登入頁面之預填與強制預設
type ServerConfig struct {
	DefaultIMAPHost              string
	DefaultIMAPPort              int
	DefaultSMTPHost              string
	DefaultSMTPPort              int
	DefaultAllowInsecureTLS      bool
	DefaultSieveHost             string
	DefaultSievePort             int
	DefaultSieveUseTLS           bool
	DefaultSieveAllowInsecureTLS bool
	SieveDebug                   bool
	CookieSecure                 bool
	Require2FA                   bool
	RequirePGP                   bool
	DBBackup                     DBBackupSchedule
	LDAP                         *LDAPConfig
	WebAuthn                     *WebAuthnConfig
	// AllowedHosts 只回應呢啲 Host（忽略大小寫同 port）；空 = 不限制。
	// 由 ALLOWED_HOSTS 環境變數載入（逗號分隔）。
	AllowedHosts []string
}

// DBBackupSchedule SQLite 自動備份週期（DB_BACKUP）。
type DBBackupSchedule string

const (
	DBBackupDisable DBBackupSchedule = "DISABLE"
	DBBackupDaily   DBBackupSchedule = "DAILY"
	DBBackupWeekly  DBBackupSchedule = "WEEKLY"
	DBBackupMonthly DBBackupSchedule = "MONTHLY"
)

// LDAPConfig OpenBSD ldapd 連接設定（僅用於變更密碼；登入仍為 IMAP bind）。
// 文檔見 docs/LDAP.md。
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

// WebAuthnConfig passkey / WebAuthn 第二因素設定。文檔見 docs/PASSKEY.md。
// RP ID 必須係 origin 嘅 registrable domain，且同 origin 一致（唔可以係 IP）；
// 換 domain 會令已註冊 passkey 失效。未設定即功能停用。
type WebAuthnConfig struct {
	RPID      string   // WEBAUTHN_RP_ID，例 "mail.example.com"
	RPOrigins []string // WEBAUTHN_RP_ORIGINS，逗號分隔，例 "https://mail.example.com"
	RPName    string   // WEBAUTHN_RP_NAME，OS 提示顯示名，預設 "e2Mail"
}

// Ready 判斷 passkey 功能是否配置完整可用（nil-safe）
func (w *WebAuthnConfig) Ready() bool {
	return w != nil && w.RPID != "" && len(w.RPOrigins) > 0
}

// Load 從環境變數載入設定；未設定的欄位採用安全預設值（IMAP 993 / SMTP 587 / 不容許自簽）
func Load() *ServerConfig {
	cfg := &ServerConfig{
		DefaultIMAPPort:              993,
		DefaultSMTPPort:              587,
		DefaultSievePort:             4190,
		DefaultSieveUseTLS:           true,
		DefaultAllowInsecureTLS:      false,
		DefaultSieveAllowInsecureTLS: false,
		CookieSecure:                 true,
		Require2FA:                   true,
		RequirePGP:                   true,
		DBBackup:                     DBBackupDisable,
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
	if v := os.Getenv("DEFAULT_SIEVE_HOST"); v != "" {
		cfg.DefaultSieveHost = v
	}
	if v := os.Getenv("DEFAULT_SIEVE_PORT"); v != "" {
		if port, err := strconv.Atoi(v); err == nil && port > 0 {
			cfg.DefaultSievePort = port
		}
	}
	if v := os.Getenv("DEFAULT_SIEVE_USE_TLS"); v != "" {
		cfg.DefaultSieveUseTLS = parseBool(v)
	}
	if v := os.Getenv("DEFAULT_SIEVE_ALLOW_INSECURE_TLS"); v != "" {
		cfg.DefaultSieveAllowInsecureTLS = parseBool(v)
	}
	if v := os.Getenv("SIEVE_DEBUG"); v != "" {
		cfg.SieveDebug = parseBool(v)
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
	if v := os.Getenv("DB_BACKUP"); v != "" {
		if s, ok := ParseDBBackup(v); ok {
			cfg.DBBackup = s
		} else {
			log.Printf("⚠️  Invalid DB_BACKUP=%q (want DISABLE, DAILY, WEEKLY, MONTHLY), using DISABLE", v)
			cfg.DBBackup = DBBackupDisable
		}
	}
	if v := os.Getenv("ALLOWED_HOSTS"); v != "" {
		cfg.AllowedHosts = splitCSV(v)
	}

	cfg.LDAP = loadLDAP()
	cfg.WebAuthn = loadWebAuthn()
	return cfg
}

// splitCSV 將逗號分隔字串拆成清理後嘅非空清單
func splitCSV(raw string) []string {
	var out []string
	for _, part := range strings.Split(raw, ",") {
		if part = strings.TrimSpace(part); part != "" {
			out = append(out, part)
		}
	}
	return out
}

// ParseDBBackup 解析 DB_BACKUP：DISABLE / DAILY / WEEKLY / MONTHLY（大小寫不敏感）。
// 空字串視為 DISABLE；無法辨識時 ok=false。
func ParseDBBackup(s string) (DBBackupSchedule, bool) {
	switch strings.ToUpper(strings.TrimSpace(s)) {
	case "", "DISABLE":
		return DBBackupDisable, true
	case "DAILY":
		return DBBackupDaily, true
	case "WEEKLY":
		return DBBackupWeekly, true
	case "MONTHLY":
		return DBBackupMonthly, true
	default:
		return DBBackupDisable, false
	}
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

// loadWebAuthn 由 WEBAUTHN_* 環境變數載入 passkey 設定（未設定即 Ready()=false）
func loadWebAuthn() *WebAuthnConfig {
	w := &WebAuthnConfig{RPName: "e2Mail"}
	if v := strings.TrimSpace(os.Getenv("WEBAUTHN_RP_NAME")); v != "" {
		w.RPName = v
	}
	w.RPID = strings.TrimSpace(os.Getenv("WEBAUTHN_RP_ID"))
	w.RPOrigins = parseOrigins(os.Getenv("WEBAUTHN_RP_ORIGINS"))

	if w.RPID == "" || len(w.RPOrigins) == 0 {
		if os.Getenv("WEBAUTHN_RP_ID") != "" || os.Getenv("WEBAUTHN_RP_ORIGINS") != "" {
			log.Printf("⚠️  WEBAUTHN_RP_ID / WEBAUTHN_RP_ORIGINS 設定不完整，passkey 功能保持停用")
		}
	}
	return w
}

// parseOrigins 解析逗號分隔嘅 origin 清單，去除空白同結尾斜線
func parseOrigins(raw string) []string {
	var out []string
	for _, part := range strings.Split(raw, ",") {
		origin := strings.TrimRight(strings.TrimSpace(part), "/")
		if origin != "" {
			out = append(out, origin)
		}
	}
	return out
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
