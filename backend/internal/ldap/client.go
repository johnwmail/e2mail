package ldap

import (
	"crypto/rand"
	"crypto/sha1" //nolint:gosec // {SSHA} 格式由 OpenBSD ldapd 規範指定
	"crypto/sha256"
	"crypto/sha512"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"errors"
	"fmt"
	"hash"
	"io"
	"net"
	"os"
	"strings"
	"time"

	goldap "github.com/go-ldap/ldap/v3"

	"github.com/johnwmail/e2mail/backend/internal/config"
)

// ErrInvalidCredentials 表示 bind 因密碼錯誤而失敗（handler 映射為 401）；
// 其他錯誤代表 LDAP 服務不可達／被拒（映射為 502）
var ErrInvalidCredentials = errors.New("ldap invalid credentials")

const sshaSaltLen = 16

// Conn 抽象 *goldap.Conn，令單元測試可注入 fake
type Conn interface {
	Bind(username, password string) error
	Modify(req *goldap.ModifyRequest) error
	PasswordModify(req *goldap.PasswordModifyRequest) (*goldap.PasswordModifyResult, error)
	Close() error
}

// Client 對 LDAP 目錄做用戶 self-bind 驗證與管理員改密。
// ldapd：客戶端預先 {SSHA*} 再 Modify；OpenLDAP slapd：RFC 3062。見 docs/LDAP.md。
type Client struct {
	opts config.LDAPConfig
	dial func() (Conn, error)
}

// New 由 LDAPConfig 建立 Client（不做 Ready 檢查；handler 負責 gate）
func New(opts config.LDAPConfig) *Client {
	c := &Client{opts: opts}
	c.dial = c.dialConn
	return c
}

func (c *Client) scheme() string {
	s := strings.ToLower(strings.TrimSpace(c.opts.PasswordScheme))
	if s == "" {
		return "ssha"
	}
	return s
}

// tlsConfig 按 opts 組裝 TLS 設定（支援自簽 RootCA）
func (c *Client) tlsConfig() (*tls.Config, error) {
	cfg := &tls.Config{InsecureSkipVerify: c.opts.AllowInsecureTLS} //nolint:gosec // 僅顯式 LDAP_ALLOW_INSECURE_TLS 時生效
	if c.opts.CAFile == "" {
		return cfg, nil
	}
	pemData, err := os.ReadFile(c.opts.CAFile)
	if err != nil {
		return nil, fmt.Errorf("read LDAP CA %q failed: %w", c.opts.CAFile, err)
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(pemData) {
		return nil, fmt.Errorf("parse LDAP CA %q failed: no valid PEM", c.opts.CAFile)
	}
	cfg.RootCAs = pool
	return cfg, nil
}

// dialConn 依 opts 建立已加密的 LDAP 連線（ldaps:// 直連，ldap:// 可配 STARTTLS）
func (c *Client) dialConn() (Conn, error) {
	dialer := &net.Dialer{Timeout: 10 * time.Second}
	tlsCfg, err := c.tlsConfig()
	if err != nil {
		return nil, err
	}

	var conn *goldap.Conn
	if strings.HasPrefix(strings.ToLower(c.opts.URL), "ldaps://") {
		conn, err = goldap.DialURL(c.opts.URL, goldap.DialWithDialer(dialer), goldap.DialWithTLSConfig(tlsCfg))
	} else {
		conn, err = goldap.DialURL(c.opts.URL, goldap.DialWithDialer(dialer))
		if err == nil && c.opts.StartTLS {
			if tlsErr := conn.StartTLS(tlsCfg); tlsErr != nil {
				_ = conn.Close()
				return nil, fmt.Errorf("ldap starttls failed: %w", tlsErr)
			}
		}
	}
	if err != nil {
		return nil, fmt.Errorf("ldap connect failed: %w", err)
	}
	return conn, nil
}

// UserDN 將 LDAP_USER_DN_TEMPLATE 展開為用戶 entry DN。
// %s → 完整 email（DN-escaped）；%u → local part（DN-escaped）
// 以單一趟 NewReplacer 替換，避免 email 內含 "%u" 等 token 時被二次展開。
func (c *Client) UserDN(email string) (string, error) {
	if c.opts.UserDNTemplate == "" {
		return "", errors.New("ldap user dn template not configured")
	}
	local := email
	if at := strings.Index(email, "@"); at >= 0 {
		local = email[:at]
	}
	repl := strings.NewReplacer("%s", escapeDNValue(email), "%u", escapeDNValue(local))
	return repl.Replace(c.opts.UserDNTemplate), nil
}

// VerifyUserBind 以用戶自己的 DN + 密碼做 simple bind，作為舊密碼之權威驗證
func (c *Client) VerifyUserBind(userDN, password string) error {
	conn, err := c.dial()
	if err != nil {
		return err
	}
	defer func() { _ = conn.Close() }()
	return wrapLDAPerr(conn.Bind(userDN, password))
}

// ChangePassword 以管理員 DN bind 後改密。
// rfc3062：RFC 3062 Password Modify（明文；slapd 自行 hash）。
// 其餘：Modify REPLACE userPassword 為客戶端預先產生嘅 RFC 2307 字串（ldapd 必須）。
func (c *Client) ChangePassword(userDN, newPassword string) error {
	conn, err := c.dial()
	if err != nil {
		return err
	}
	defer func() { _ = conn.Close() }()

	if err := conn.Bind(c.opts.RootDN, c.opts.RootPW); err != nil {
		return fmt.Errorf("ldap root bind failed: %w", wrapLDAPerr(err))
	}

	if c.scheme() == "rfc3062" {
		req := goldap.NewPasswordModifyRequest(userDN, "", newPassword)
		if _, err := conn.PasswordModify(req); err != nil {
			return fmt.Errorf("ldap password modify failed: %w", wrapLDAPerr(err))
		}
		return nil
	}

	hashed, err := c.HashPassword(newPassword)
	if err != nil {
		return err
	}
	req := goldap.NewModifyRequest(userDN, nil)
	req.Replace("userPassword", []string{hashed})
	if err := conn.Modify(req); err != nil {
		return fmt.Errorf("ldap modify userPassword failed: %w", wrapLDAPerr(err))
	}
	return nil
}

// HashPassword 按配置之 scheme 產生 userPassword 寫入值（Modify 路徑；rfc3062 唔用）
func (c *Client) HashPassword(password string) (string, error) {
	switch c.scheme() {
	case "ssha":
		return HashSSHA(password)
	case "ssha256":
		return HashSSHA256(password)
	case "ssha512":
		return HashSSHA512(password)
	case "rfc3062":
		return "", errors.New("LDAP_PASSWORD_SCHEME=rfc3062 does not pre-hash (server hashes)")
	default:
		return "", errors.New("unsupported LDAP_PASSWORD_SCHEME")
	}
}

func randomSalt() ([]byte, error) {
	salt := make([]byte, sshaSaltLen)
	if _, err := io.ReadFull(rand.Reader, salt); err != nil {
		return nil, fmt.Errorf("failed to generate password salt: %w", err)
	}
	return salt, nil
}

// HashSSHA 產生 ldapd bind 驗證器認可嘅 canonical SSHA 格式：
// "{SSHA}" + base64( SHA1(password || salt) || salt )
func HashSSHA(password string) (string, error) {
	salt, err := randomSalt()
	if err != nil {
		return "", err
	}
	return formatSSHA(password, salt), nil
}

// HashSSHA256 RFC 2307bis：{SSHA256} + base64( SHA256(password || salt) || salt )
func HashSSHA256(password string) (string, error) {
	salt, err := randomSalt()
	if err != nil {
		return "", err
	}
	return formatSSHA256(password, salt), nil
}

// HashSSHA512 RFC 2307bis：{SSHA512} + base64( SHA512(password || salt) || salt )
func HashSSHA512(password string) (string, error) {
	salt, err := randomSalt()
	if err != nil {
		return "", err
	}
	return formatSSHA512(password, salt), nil
}

func formatSSHA(password string, salt []byte) string {
	h := sha1.New() //nolint:gosec
	h.Write([]byte(password)) // codeql[go/weak-cryptographic-algorithm] - {SSHA} 格式由 OpenBSD ldapd 規範強制為 SHA-1
	h.Write(salt)
	return encodeSalted("{SSHA}", h, salt)
}

func formatSSHA256(password string, salt []byte) string {
	h := sha256.New()
	h.Write([]byte(password))
	h.Write(salt)
	return encodeSalted("{SSHA256}", h, salt)
}

func formatSSHA512(password string, salt []byte) string {
	h := sha512.New()
	h.Write([]byte(password))
	h.Write(salt)
	return encodeSalted("{SSHA512}", h, salt)
}

func encodeSalted(tag string, h hash.Hash, salt []byte) string {
	digest := append(h.Sum(nil), salt...)
	return tag + base64.StdEncoding.EncodeToString(digest)
}

// wrapLDAPerr 將 go-ldap 的 invalidCredentials 錯誤正規化為 ErrInvalidCredentials
func wrapLDAPerr(err error) error {
	if err == nil {
		return nil
	}
	if goldap.IsErrorWithCode(err, goldap.LDAPResultInvalidCredentials) {
		return fmt.Errorf("%w: %v", ErrInvalidCredentials, err)
	}
	return err
}

// escapeDNValue 按 RFC 4514 轉義 DN attribute value 中的特殊字元
func escapeDNValue(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		ch := s[i]
		switch {
		case strings.IndexByte(`,+\-"<>;=\*~()#&|/?`, ch) >= 0:
			b.WriteByte('\\')
			b.WriteByte(ch)
		case (ch == ' ' || ch == '\t') && (i == 0 || i == len(s)-1):
			fmt.Fprintf(&b, "\\%02X", ch)
		default:
			b.WriteByte(ch)
		}
	}
	return b.String()
}
