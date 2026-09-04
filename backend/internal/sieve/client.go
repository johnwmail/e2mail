package sieve

import (
	"context"
	"crypto/tls"
	"encoding/base64"
	"fmt"
	"log"
	"net"
	"net/textproto"
	"strconv"
	"strings"
	"time"
)

// Config ManageSieve 連線設定
type Config struct {
	Host             string
	Port             int
	UseTLS           bool
	AllowInsecureTLS bool
	Username         string
	Password         string
	Debug            bool // SIEVE_DEBUG=true 時記錄 raw 協議往來
}

// ScriptInfo 單一 Sieve 腳本資訊
type ScriptInfo struct {
	Name   string `json:"name"`
	Active bool   `json:"active"`
	Size   int    `json:"size,omitempty"`
}

// Client ManageSieve 客戶端（短連即關）
//
// 注意：Dovecot 的 managesieve-login 實作「無 tag」的行協議（Roundcube
// Net_ManageSieve 同樣如此），所有命令直接以動詞開頭，回應以
// OK / NO / BAD 最終行結束；RFC 5804 的 tag 前綴（如 "A0001 STARTTLS"）
// 會被 Dovecot 拒絕為 "Error in MANAGESIEVE command received by server."
type Client struct {
	conn   net.Conn
	tp     *textproto.Conn
	caps   map[string]string
	sasl   []string
	tlsCap bool
	debug  bool
}

// --- low level I/O helpers (debug logging) ---

func (c *Client) cfmtf(format string, args ...any) error {
	line := fmt.Sprintf(format, args...)
	if c.debug {
		if idx := strings.Index(line, "AUTHENTICATE"); idx >= 0 {
			log.Printf("[SIEVE-C] %s <redacted>", line[:idx+len("AUTHENTICATE")])
		} else {
			log.Printf("[SIEVE-C] %s", line)
		}
	}
	return c.tp.PrintfLine("%s", line)
}

func (c *Client) cline() (string, error) {
	line, err := c.tp.ReadLine()
	if err != nil {
		if c.debug {
			log.Printf("[SIEVE-S] <read error: %v>", err)
		}
		return line, err
	}
	if c.debug {
		log.Printf("[SIEVE-S] %s", line)
	}
	return line, nil
}

func (c *Client) writeRaw(s string) error {
	_, err := c.conn.Write([]byte(s))
	return err
}

// isFinalLine 判斷 ManageSieve 命令的最終回應行
func isFinalLine(line string) bool {
	up := strings.ToUpper(line)
	for _, p := range []string{"OK", "NO", "BAD"} {
		if up == p || strings.HasPrefix(up, p+" ") || strings.HasPrefix(up, p+"\t") {
			return true
		}
	}
	return false
}

// isFailureLine 最終行是否為錯誤（NO / BAD）
func isFailureLine(line string) bool {
	up := strings.ToUpper(line)
	return strings.HasPrefix(up, "NO") || strings.HasPrefix(up, "BAD")
}

// readUntilFinal 讀取行直到最終回應行；untagged 行交給 onLine 處理
func (c *Client) readUntilFinal(onLine func(line string)) error {
	for {
		line, err := c.cline()
		if err != nil {
			return fmt.Errorf("sieve read failed: %w", err)
		}
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		if isFinalLine(trimmed) {
			if isFailureLine(trimmed) {
				return fmt.Errorf("server replied: %s", trimmed)
			}
			return nil
		}
		if onLine != nil {
			onLine(trimmed)
		}
	}
}

// base64Token 標準 base64（Dovecot 的 AUTHENTICATE initial-response 用一般
// base64；RFC 5804 base40 的雙 '=' 反而會被 Dovecot 拒絕）
func base64Token(data []byte) string {
	return base64.StdEncoding.EncodeToString(data)
}

// --- connection ---

// Dial 建立並認證 ManageSieve 連線
func Dial(ctx context.Context, cfg Config) (*Client, error) {
	host := cfg.Host
	port := cfg.Port
	if port == 0 {
		port = 4190
	}
	if host == "" {
		return nil, fmt.Errorf("sieve host is empty")
	}
	addr := net.JoinHostPort(host, strconv.Itoa(port))

	dialer := &net.Dialer{Timeout: 10 * time.Second}
	conn, err := dialer.DialContext(ctx, "tcp", addr)
	if err != nil {
		return nil, fmt.Errorf("sieve dial failed %s: %w", addr, err)
	}
	if cfg.Debug {
		log.Printf("[SIEVE] dial ok %s (UseTLS=%v AllowInsecure=%v user=%s)", addr, cfg.UseTLS, cfg.AllowInsecureTLS, cfg.Username)
	}

	_ = conn.SetDeadline(time.Now().Add(30 * time.Second))

	tp := textproto.NewConn(conn)
	c := &Client{conn: conn, tp: tp, caps: make(map[string]string), debug: cfg.Debug}

	if err := c.readBanner(); err != nil {
		_ = c.Close()
		return nil, fmt.Errorf("sieve banner failed %s: %w", addr, err)
	}
	if cfg.Debug {
		log.Printf("[SIEVE] banner ok %s sasl=%v tlsCap=%v", addr, c.sasl, c.tlsCap)
	}

	// 明文連線必須 STARTTLS；失敗即斷線，永不明文認證
	if !isTLSConn(conn) {
		if !c.tlsCap {
			_ = c.Close()
			return nil, fmt.Errorf("sieve %s does not offer STARTTLS (plaintext is not allowed)", addr)
		}
		if err := c.doSTARTTLS(cfg); err != nil {
			_ = c.Close()
			return nil, fmt.Errorf("sieve STARTTLS failed %s: %w", addr, err)
		}
		c.caps = make(map[string]string)
		c.sasl = nil
		c.tlsCap = false
		if err := c.readPostTLSCapabilities(); err != nil {
			_ = c.Close()
			return nil, fmt.Errorf("sieve post-STARTTLS capability failed %s: %w", addr, err)
		}
		if cfg.Debug {
			log.Printf("[SIEVE] post-STARTTLS capability ok %s sasl=%v", addr, c.sasl)
		}
	}

	_ = c.conn.SetDeadline(time.Now().Add(25 * time.Second))
	if err := c.authenticate(cfg.Username, cfg.Password); err != nil {
		_ = c.Close()
		return nil, err
	}

	_ = c.conn.SetDeadline(time.Time{})
	return c, nil
}

func isTLSConn(conn net.Conn) bool {
	_, ok := conn.(*tls.Conn)
	return ok
}

func sieveTLSConfig(cfg Config) *tls.Config {
	serverName := cfg.Host
	if net.ParseIP(serverName) != nil {
		serverName = ""
	}
	return &tls.Config{
		ServerName:         serverName,
		InsecureSkipVerify: cfg.AllowInsecureTLS, //nolint:gosec // 僅 AllowInsecureTLS
	}
}

func (c *Client) readBanner() error {
	return c.readUntilFinal(parseCap(c))
}

func parseCap(c *Client) func(string) {
	return func(line string) { parseCapLine(c, line) }
}

func parseCapLine(c *Client, line string) {
	line = strings.TrimSpace(line)
	if line == "" {
		return
	}
	if strings.HasPrefix(line, "\"") {
		end := strings.Index(line[1:], "\"")
		if end >= 0 {
			key := line[1 : 1+end]
			rest := strings.TrimSpace(line[1+end+1:])
			var val string
			if strings.HasPrefix(rest, "\"") {
				rest = strings.TrimSpace(rest)
				if len(rest) >= 2 {
					val = rest[1 : len(rest)-1]
				}
			} else if rest != "" {
				val = strings.Trim(rest, "\"")
			}
			c.caps[strings.ToUpper(key)] = val
			if strings.EqualFold(key, "SASL") {
				c.sasl = strings.Fields(val)
			}
			// Dovecot 以帶引號形式發送 "STARTTLS"
			if strings.EqualFold(key, "STARTTLS") {
				c.tlsCap = true
			}
			return
		}
	}
	upper := strings.ToUpper(strings.Trim(line, "\""))
	if upper == "STARTTLS" {
		c.tlsCap = true
	}
}

func (c *Client) doSTARTTLS(cfg Config) error {
	if err := c.cfmtf("STARTTLS"); err != nil {
		return fmt.Errorf("STARTTLS write failed: %w", err)
	}
	line, err := c.cline()
	if err != nil {
		return fmt.Errorf("STARTTLS read failed: %w", err)
	}
	trimmed := strings.TrimSpace(line)
	if !strings.HasPrefix(strings.ToUpper(trimmed), "OK") {
		return fmt.Errorf("STARTTLS rejected: %s", trimmed)
	}
	tlsConn := tls.Client(c.conn, sieveTLSConfig(cfg))
	if err := tlsConn.Handshake(); err != nil {
		return fmt.Errorf("TLS handshake failed: %w", err)
	}
	c.conn = tlsConn
	c.tp = textproto.NewConn(tlsConn)
	_ = c.conn.SetDeadline(time.Now().Add(30 * time.Second))
	if cfg.Debug {
		log.Printf("[SIEVE] STARTTLS handshake ok %s", cfg.Host)
	}
	return nil
}

// --- authentication ---

func (c *Client) authenticate(username, password string) error {
	if username == "" || password == "" {
		return fmt.Errorf("sieve username/password required")
	}
	tryMechs := []string{"PLAIN"}
	if len(c.sasl) > 0 {
		hasPlain := false
		hasLogin := false
		for _, m := range c.sasl {
			if strings.EqualFold(m, "PLAIN") {
				hasPlain = true
			}
			if strings.EqualFold(m, "LOGIN") {
				hasLogin = true
			}
		}
		switch {
		case hasPlain && hasLogin:
			tryMechs = []string{"PLAIN", "LOGIN"}
		case hasLogin:
			tryMechs = []string{"LOGIN"}
		case hasPlain:
			tryMechs = []string{"PLAIN"}
		}
	}

	var lastErr error
	// 完整 email 與 @ 前綴雙試（兼容僅認 bare user 的 Dovecot）
	usernames := []string{username}
	if strings.Contains(username, "@") {
		usernames = append(usernames, strings.Split(username, "@")[0])
	}
	for _, u := range usernames {
		for _, mech := range tryMechs {
			lastErr = c.tryAuthenticate(mech, u, password)
			if lastErr == nil {
				if c.debug {
					log.Printf("[SIEVE] auth %s as %s ok", mech, u)
				}
				return nil
			}
			log.Printf("[SIEVE] auth %s as %s failed: %v", mech, u, lastErr)
		}
	}
	return fmt.Errorf("sieve authentication failed: %w", lastErr)
}

func (c *Client) tryAuthenticate(mech, username, password string) error {
	plainToken := base64Token([]byte("\x00" + username + "\x00" + password))

	if strings.EqualFold(mech, "LOGIN") {
		if err := c.cfmtf("AUTHENTICATE \"LOGIN\""); err != nil {
			return err
		}
		step := 0
		for {
			line, err := c.cline()
			if err != nil {
				return fmt.Errorf("sieve auth read failed: %w", err)
			}
			trimmed := strings.TrimSpace(line)
			if trimmed == "" {
				continue
			}
			if strings.HasPrefix(trimmed, "+") {
				var resp string
				switch step {
				case 0:
					resp = base64Token([]byte(username))
				case 1:
					resp = base64Token([]byte(password))
				default:
					return fmt.Errorf("sieve LOGIN got unexpected challenge count")
				}
				step++
				if c.debug {
					log.Printf("[SIEVE-C] <login resp #%d redacted>", step)
				}
				if err := c.writeRaw(resp + "\r\n"); err != nil {
					return err
				}
				continue
			}
			if isFinalLine(trimmed) {
				if isFailureLine(trimmed) {
					return fmt.Errorf("sieve authentication failed: %s", trimmed)
				}
				return nil
			}
			// 非最終行（如 capability 推送）忽略
			parseCapLine(c, trimmed)
		}
	}

	if err := c.cfmtf("AUTHENTICATE \"PLAIN\" \"%s\"", plainToken); err != nil {
		return err
	}
	for {
		line, err := c.cline()
		if err != nil {
			return fmt.Errorf("sieve auth read failed: %w", err)
		}
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		if strings.HasPrefix(trimmed, "+") {
			// 伺服器不接受 initial-response，以挑戰回覆
			if c.debug {
				log.Printf("[SIEVE-C] <plain resp redacted>")
			}
			if err := c.writeRaw(plainToken + "\r\n"); err != nil {
				return err
			}
			continue
		}
		if isFinalLine(trimmed) {
			if isFailureLine(trimmed) {
				return fmt.Errorf("sieve authentication failed: %s", trimmed)
			}
			return nil
		}
		parseCapLine(c, trimmed)
	}
}

// --- commands ---

// CapabilityMap 返回當前能力映射
func (c *Client) CapabilityMap() map[string]string {
	out := make(map[string]string, len(c.caps))
	for k, v := range c.caps {
		out[k] = v
	}
	return out
}

// readPostTLSCapabilities 於 TLS 握手後取得能力：
// Dovecot 會自動推送新 pre-auth capability banner + 最終行，直接讀取即可；
// 若伺服器無推送（如 Cyrus），短逾時後改為主動發 CAPABILITY。
func (c *Client) readPostTLSCapabilities() error {
	_ = c.conn.SetDeadline(time.Now().Add(5 * time.Second))
	err := c.readUntilFinal(parseCap(c))
	if err == nil && len(c.sasl) > 0 {
		return nil // 收到 Dovecot 推送的 greeting（含 SASL）
	}
	// 無推送或無 SASL：主動 CAPABILITY
	_ = c.conn.SetDeadline(time.Now().Add(20 * time.Second))
	if cerr := c.Capability(); cerr != nil {
		if err != nil {
			return err
		}
		return cerr
	}
	return nil
}

// Capability 發送 CAPABILITY 指令並更新能力表
func (c *Client) Capability() error {
	if err := c.cfmtf("CAPABILITY"); err != nil {
		return err
	}
	return c.readUntilFinal(parseCap(c))
}

// ListScripts 列出腳本
func (c *Client) ListScripts() ([]ScriptInfo, error) {
	if err := c.cfmtf("LISTSCRIPTS"); err != nil {
		return nil, err
	}
	var scripts []ScriptInfo
	err := c.readUntilFinal(func(line string) {
		names := extractQuoted(line)
		for _, n := range names {
			if strings.EqualFold(n, "ACTIVE") {
				continue
			}
			si := ScriptInfo{Name: n}
			if strings.Contains(strings.ToUpper(line), "ACTIVE") {
				si.Active = true
			}
			scripts = append(scripts, si)
		}
	})
	if err != nil {
		return nil, fmt.Errorf("LISTSCRIPTS failed: %w", err)
	}
	// 去重（部分 server 每行一腳本，部分一行多腳本）
	seen := make(map[string]int)
	dedup := make([]ScriptInfo, 0, len(scripts))
	for _, s := range scripts {
		if idx, ok := seen[s.Name]; ok {
			if s.Active {
				dedup[idx].Active = true
			}
			continue
		}
		seen[s.Name] = len(dedup)
		dedup = append(dedup, s)
	}
	return dedup, nil
}

// GetScript 取得腳本內容（回應為 {len}\r\n<data>\r\n 後最終行）
func (c *Client) GetScript(name string) (string, error) {
	if name == "" {
		return "", fmt.Errorf("script name required")
	}
	if err := c.cfmtf("GETSCRIPT \"%s\"", escape(name)); err != nil {
		return "", err
	}
	var buf strings.Builder
	for {
		line, err := c.cline()
		if err != nil {
			return "", fmt.Errorf("GETSCRIPT read failed: %w", err)
		}
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "{") && strings.HasSuffix(trimmed, "}") {
			inner := strings.TrimSuffix(trimmed[1:len(trimmed)-1], "+")
			n, err := strconv.Atoi(strings.TrimSpace(inner))
			if err != nil {
				return "", fmt.Errorf("GETSCRIPT bad literal %q", trimmed)
			}
			if n == 0 {
				continue
			}
			data := make([]byte, n)
			if _, err := readExact(c.tp, data); err != nil {
				return "", fmt.Errorf("GETSCRIPT read literal failed: %w", err)
			}
			buf.Write(data)
			continue
		}
		if trimmed == "" {
			continue
		}
		if isFinalLine(trimmed) {
			if isFailureLine(trimmed) {
				if strings.Contains(trimmed, "NONEXISTENT") || strings.Contains(strings.ToLower(trimmed), "not found") {
					return "", fmt.Errorf("script not found: %s", trimmed)
				}
				return "", fmt.Errorf("GETSCRIPT failed: %s", trimmed)
			}
			return buf.String(), nil
		}
	}
}

// PutScript 上傳腳本（非同步字面量 {len+}，Dovecot 支援）
func (c *Client) PutScript(name, content string) error {
	if name == "" {
		return fmt.Errorf("script name required")
	}
	if err := c.cfmtf("PUTSCRIPT \"%s\" {%d+}", escape(name), len(content)); err != nil {
		return err
	}
	if len(content) > 0 {
		if _, err := c.conn.Write([]byte(content)); err != nil {
			return err
		}
	}
	if _, err := c.conn.Write([]byte("\r\n")); err != nil {
		return err
	}
	if err := c.readUntilFinal(nil); err != nil {
		return fmt.Errorf("PUTSCRIPT failed: %w", err)
	}
	return nil
}

// DeleteScript 刪除腳本
func (c *Client) DeleteScript(name string) error {
	if name == "" {
		return fmt.Errorf("script name required")
	}
	if err := c.cfmtf("DELETESCRIPT \"%s\"", escape(name)); err != nil {
		return err
	}
	if err := c.readUntilFinal(nil); err != nil {
		return fmt.Errorf("DELETESCRIPT failed: %w", err)
	}
	return nil
}

// SetActive 設定活動腳本（空字串表示停用全部）
func (c *Client) SetActive(name string) error {
	if err := c.cfmtf("SETACTIVE \"%s\"", escape(name)); err != nil {
		return err
	}
	if err := c.readUntilFinal(nil); err != nil {
		return fmt.Errorf("SETACTIVE failed: %w", err)
	}
	return nil
}

// CheckScript 檢查語法（不保存）
func (c *Client) CheckScript(content string) error {
	if err := c.cfmtf("CHECKSCRIPT {%d+}", len(content)); err != nil {
		return err
	}
	if len(content) > 0 {
		if _, err := c.conn.Write([]byte(content)); err != nil {
			return err
		}
	}
	if _, err := c.conn.Write([]byte("\r\n")); err != nil {
		return err
	}
	if err := c.readUntilFinal(nil); err != nil {
		return fmt.Errorf("CHECKSCRIPT failed: %w", err)
	}
	return nil
}

// HaveSpace 檢查配額（選用）
func (c *Client) HaveSpace(name string, size int) error {
	if err := c.cfmtf("HAVESPACE \"%s\" %d", escape(name), size); err != nil {
		return err
	}
	if err := c.readUntilFinal(nil); err != nil {
		return fmt.Errorf("HAVESPACE failed: %w", err)
	}
	return nil
}

// Close 關閉連線
func (c *Client) Close() error {
	if c == nil {
		return nil
	}
	if c.tp != nil {
		_ = c.cfmtf("LOGOUT")
	}
	if c.conn != nil {
		return c.conn.Close()
	}
	return nil
}

// --- helpers ---

func escape(s string) string {
	return strings.ReplaceAll(s, "\"", "\\\"")
}

func extractQuoted(line string) []string {
	var out []string
	inQuote := false
	escaped := false
	var cur strings.Builder
	for _, ch := range line {
		if escaped {
			cur.WriteRune(ch)
			escaped = false
			continue
		}
		if ch == '\\' && inQuote {
			escaped = true
			continue
		}
		if ch == '"' {
			if inQuote {
				out = append(out, cur.String())
				cur.Reset()
				inQuote = false
			} else {
				inQuote = true
			}
			continue
		}
		if inQuote {
			cur.WriteRune(ch)
		}
	}
	return out
}

// readExact 從 textproto 內建 bufio.Reader 讀滿 n bytes
func readExact(tp *textproto.Conn, buf []byte) (int, error) {
	r := tp.R
	total := 0
	for total < len(buf) {
		n, err := r.Read(buf[total:])
		total += n
		if err != nil {
			return total, err
		}
	}
	return total, nil
}
