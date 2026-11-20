package config

import (
	"log"
	"os"
	"strconv"
	"strings"
)

// ServerConfig 由環境變數載入的伺服器預設值，作為登入頁面之預填與強制預設
type ServerConfig struct {
	// MailMode 控制登入 server 是否鎖定："locked" / "prefill"；空 = 自動
	// （IMAP + SMTP host 同時設定時鎖定）。
	MailMode                     string
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
	// AllowPrivateNetworks 允許 IMAP/SMTP/Sieve 連接私有/loopback 位址
	// （預設 false，防止 SSRF；自架內網 mail server 才需要開啟）。
	AllowPrivateNetworks bool
	// OutboundAllowedHosts 白名單，繞過私有位址檢查（逗號分隔，hostname 或 IP）。
	OutboundAllowedHosts []string
	// LoginAllowedDomains 只允許呢啲 email domain 登入（逗號分隔；空 = 不限制）。
	// 主要配合固定 server 使用，避免用戶用其他 domain 的 email 登入同一部 IMAP。
	LoginAllowedDomains []string
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
	// === Mail server ===
	// 最簡單：MAIL_SERVER=host → IMAP/SMTP 共用同一 host，預設 locked。
	mailServer := strings.TrimSpace(os.Getenv("MAIL_SERVER"))
	imapHost := envString("MAIL_IMAP_HOST")
	smtpHost := envString("MAIL_SMTP_HOST")
	if mailServer != "" {
		if imapHost == "" {
			imapHost = mailServer
		}
		if smtpHost == "" {
			smtpHost = mailServer
		}
	}
	cfg.DefaultIMAPHost = imapHost
	cfg.DefaultSMTPHost = smtpHost
	cfg.DefaultIMAPPort = envPort("MAIL_IMAP_PORT", 993)
	cfg.DefaultSMTPPort = envPort("MAIL_SMTP_PORT", 587)
	cfg.DefaultAllowInsecureTLS = envBool("MAIL_ALLOW_INSECURE_TLS", false)
	cfg.DefaultSieveHost = envString("MAIL_SIEVE_HOST")
	cfg.DefaultSievePort = envPort("MAIL_SIEVE_PORT", 4190)
	cfg.DefaultSieveUseTLS = envBool("MAIL_SIEVE_USE_TLS", true)
	cfg.DefaultSieveAllowInsecureTLS = envBool("MAIL_SIEVE_ALLOW_INSECURE_TLS", false)

	if v := strings.TrimSpace(os.Getenv("MAIL_MODE")); v != "" {
		switch strings.ToLower(v) {
		case "locked", "prefill":
			cfg.MailMode = strings.ToLower(v)
		default:
			log.Printf("⚠️  Invalid MAIL_MODE=%q (want locked or prefill), using auto", v)
		}
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
	cfg.AllowPrivateNetworks = envBool("MAIL_ALLOW_PRIVATE_NETWORKS", false)
	if v := envString("MAIL_OUTBOUND_ALLOWED_HOSTS"); v != "" {
		cfg.OutboundAllowedHosts = splitCSV(v)
	}
	if v := envString("MAIL_ALLOWED_DOMAINS"); v != "" {
		for _, domain := range splitCSV(v) {
			if d := normalizeDomain(domain); d != "" {
				cfg.LoginAllowedDomains = append(cfg.LoginAllowedDomains, d)
			}
		}
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

// HasFixedServers 回報登入 server 係咪由部署固定。只有 IMAP 同 SMTP host
// 都已設定時才會鎖定；否則沿用「預填但可改」行為。
func (c *ServerConfig) HasFixedServers() bool {
	if c == nil || !c.HasBothMailHosts() {
		return false
	}
	return strings.ToLower(strings.TrimSpace(c.MailMode)) != "prefill"
}

// HasBothMailHosts 回報 IMAP 同 SMTP host 是否都已設定。
func (c *ServerConfig) HasBothMailHosts() bool {
	return c != nil && c.DefaultIMAPHost != "" && c.DefaultSMTPHost != ""
}

// LoginDomainAllowed 回報 email 的 domain 是否在 MAIL_ALLOWED_DOMAINS 內。
// 空 allow-list = 不限制；email 冇 @ 或 domain 空白 = 不允許（當 allow-list 非空）。
func (c *ServerConfig) LoginDomainAllowed(email string) bool {
	if c == nil || len(c.LoginAllowedDomains) == 0 {
		return true
	}
	email = strings.TrimSpace(email)
	at := strings.LastIndex(email, "@")
	if at <= 0 || at == len(email)-1 {
		return false
	}
	domain := normalizeDomain(email[at+1:])
	for _, allowed := range c.LoginAllowedDomains {
		if domain == allowed {
			return true
		}
	}
	return false
}

func normalizeDomain(domain string) string {
	domain = strings.ToLower(strings.TrimSpace(domain))
	domain = strings.TrimPrefix(domain, "@")
	domain = strings.TrimSuffix(domain, ".")
	return domain
}

func envString(key string) string {
	return strings.TrimSpace(os.Getenv(key))
}

func envBool(key string, def bool) bool {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return parseBool(v)
	}
	return def
}

func envPort(key string, def int) int {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return def
	}
	port, err := strconv.Atoi(raw)
	if err != nil || port <= 0 {
		log.Printf("⚠️  Invalid %s=%q, using %d", key, raw, def)
		return def
	}
	return port
}

func parseBool(s string) bool {
	switch s {
	case "1", "true", "TRUE", "True", "yes", "YES", "on", "ON":
		return true
	default:
		return false
	}
}
