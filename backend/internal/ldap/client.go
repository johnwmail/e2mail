package ldap

import (
	"crypto/rand"
	"crypto/sha1" //nolint:gosec // {SSHA} 格式由 OpenBSD ldapd 規範指定
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"errors"
	"fmt"
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
	Close() error
}

// Client 對 OpenBSD ldapd 做用戶 self-bind 驗證與 rootdn Modify 改密。
// 設計與格式依據見 repo 根目錄 LDAP.md。
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

// ChangePassword 以 rootdn bind 後將用戶 entry 的 userPassword REPLACE 為
// {SSHA}(newPassword)。ldapd 唔會喺寫入時 hash，故 digest 必須由我哋產生。
func (c *Client) ChangePassword(userDN, newPassword string) error {
	hashed, err := c.HashPassword(newPassword)
	if err != nil {
		return err
	}
	conn, err := c.dial()
	if err != nil {
		return err
	}
	defer func() { _ = conn.Close() }()

	if err := conn.Bind(c.opts.RootDN, c.opts.RootPW); err != nil {
		return fmt.Errorf("ldap root bind failed: %w", wrapLDAPerr(err))
	}
	req := goldap.NewModifyRequest(userDN, nil)
	req.Replace("userPassword", []string{hashed})
	if err := conn.Modify(req); err != nil {
		return fmt.Errorf("ldap modify userPassword failed: %w", wrapLDAPerr(err))
	}
	return nil
}

// HashPassword 按配置之 scheme 產生 userPassword 寫入值（v1 僅 ssha）
func (c *Client) HashPassword(password string) (string, error) {
	switch strings.ToLower(c.opts.PasswordScheme) {
	case "", "ssha":
		return HashSSHA(password)
	default:
		return "", fmt.Errorf("unsupported LDAP_PASSWORD_SCHEME %q", c.opts.PasswordScheme)
	}
}

// HashSSHA 產生 ldapd bind 驗證器認可行為 canonical SSHA 格式：
// "{SSHA}" + base64( SHA1(password || salt) || salt )
func HashSSHA(password string) (string, error) {
	salt := make([]byte, sshaSaltLen)
	if _, err := io.ReadFull(rand.Reader, salt); err != nil {
		return "", fmt.Errorf("failed to generate SSHA salt: %w", err)
	}
	return formatSSHA(password, salt), nil
}

// formatSSHA 以指定 salt 產生 SSHA（拆出以便測試向量斷言）
func formatSSHA(password string, salt []byte) string {
	h := sha1.New() //nolint:gosec // {SSHA} 格式指定 SHA-1
	h.Write([]byte(password))
	h.Write(salt)
	digest := append(h.Sum(nil), salt...)
	return "{SSHA}" + base64.StdEncoding.EncodeToString(digest)
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
