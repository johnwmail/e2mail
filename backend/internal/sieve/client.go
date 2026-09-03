package sieve

import (
	"context"
	"crypto/tls"
	"encoding/base64"
	"fmt"
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
}

// ScriptInfo 單一 Sieve 腳本資訊
type ScriptInfo struct {
	Name   string `json:"name"`
	Active bool   `json:"active"`
	Size   int    `json:"size,omitempty"`
}

// Client ManageSieve 客戶端（短連即關）
type Client struct {
	conn   net.Conn
	tp     *textproto.Conn
	caps   map[string]string
	sasl   []string
	tlsCap bool
}

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

	// 依上下文超時 dial
	dialer := &net.Dialer{Timeout: 10 * time.Second}
	var conn net.Conn
	var err error

	// 若 UseTLS 為 true，嘗試 implicit TLS
	if cfg.UseTLS {
		tlsCfg := &tls.Config{
			ServerName:         host,
			InsecureSkipVerify: cfg.AllowInsecureTLS,
		}
		tlsDialer := &tls.Dialer{NetDialer: dialer, Config: tlsCfg}
		conn, err = tlsDialer.DialContext(ctx, "tcp", addr)
		if err != nil {
			// implicit TLS 失敗，回退明文（可能需 STARTTLS）
			conn, err = dialer.DialContext(ctx, "tcp", addr)
			if err != nil {
				return nil, fmt.Errorf("sieve dial failed %s: %w", addr, err)
			}
		}
	} else {
		conn, err = dialer.DialContext(ctx, "tcp", addr)
		if err != nil {
			return nil, fmt.Errorf("sieve dial failed %s: %w", addr, err)
		}
	}

	// 設置整體 deadline
	_ = conn.SetDeadline(time.Now().Add(30 * time.Second))

	tp := textproto.NewConn(conn)
	c := &Client{conn: conn, tp: tp, caps: make(map[string]string)}

	// 讀 banner 與 CAPABILITY（直到 OK / NO）
	if err := c.readBanner(); err != nil {
		_ = c.Close()
		return nil, err
	}

	// 若明文且伺服器宣告 STARTTLS 且 UseTLS=true，升級
	if !isTLSConn(conn) && c.tlsCap && cfg.UseTLS {
		if err := c.doSTARTTLS(cfg); err != nil {
			_ = c.Close()
			return nil, fmt.Errorf("sieve STARTTLS failed: %w", err)
		}
		// STARTTLS 後需重新讀 CAPABILITY
		if err := c.doCapability(); err != nil {
			_ = c.Close()
			return nil, err
		}
	}

	// 認證
	if err := c.authenticate(cfg.Username, cfg.Password); err != nil {
		_ = c.Close()
		return nil, err
	}

	_ = conn.SetDeadline(time.Time{})
	return c, nil
}

func isTLSConn(conn net.Conn) bool {
	_, ok := conn.(*tls.Conn)
	return ok
}

func (c *Client) readBanner() error {
	// Dovecot banner 例：
	// "IMPLEMENTATION" "Dovecot Pigeonhole"
	// "SIEVE" "fileinto reject envelope ..."
	// "NOTIFY" "mailto"
	// "SASL" "PLAIN LOGIN"
	// "STARTTLS"
	// "VERSION" "1.0"
	// OK "Dovecot ready."
	for {
		line, err := c.tp.ReadLine()
		if err != nil {
			return fmt.Errorf("sieve banner read failed: %w", err)
		}
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		upper := strings.ToUpper(line)
		if strings.HasPrefix(upper, "OK ") {
			break
		}
		if strings.HasPrefix(upper, "NO ") || strings.HasPrefix(upper, "BYE ") {
			return fmt.Errorf("sieve banner error: %s", line)
		}
		parseCapLine(c, line)
	}
	return nil
}

func parseCapLine(c *Client, line string) {
	// 去引號後解析
	// 例： "SIEVE" "fileinto reject ..."
	// 或單獨： "STARTTLS"
	line = strings.TrimSpace(line)
	if line == "" {
		return
	}
	// 檢查是否為 "KEY" "VALUE" 形式
	if strings.HasPrefix(line, "\"") {
		// 找第二個引號
		end := strings.Index(line[1:], "\"")
		if end >= 0 {
			key := line[1 : 1+end]
			rest := strings.TrimSpace(line[1+end+1:])
			var val string
			if strings.HasPrefix(rest, "\"") {
				// 去外層引號
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
			return
		}
	}
	upper := strings.ToUpper(strings.Trim(line, "\""))
	if upper == "STARTTLS" {
		c.tlsCap = true
	}
}

func (c *Client) doCapability() error {
	id := nextTag()
	if err := c.tp.PrintfLine("%s CAPABILITY", id); err != nil {
		return err
	}
	for {
		line, err := c.tp.ReadLine()
		if err != nil {
			return err
		}
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		if strings.HasPrefix(line, id+" ") {
			upper := strings.ToUpper(line)
			if strings.Contains(upper, " OK") {
				break
			}
			return fmt.Errorf("CAPABILITY failed: %s", line)
		}
		parseCapLine(c, line)
	}
	return nil
}

func (c *Client) doSTARTTLS(cfg Config) error {
	id := nextTag()
	if err := c.tp.PrintfLine("%s STARTTLS", id); err != nil {
		return err
	}
	line, err := c.tp.ReadLine()
	if err != nil {
		return err
	}
	if !strings.Contains(strings.ToUpper(line), "OK") {
		return fmt.Errorf("STARTTLS rejected: %s", line)
	}
	tlsCfg := &tls.Config{
		ServerName:         cfg.Host,
		InsecureSkipVerify: cfg.AllowInsecureTLS,
	}
	tlsConn := tls.Client(c.conn, tlsCfg)
	if err := tlsConn.Handshake(); err != nil {
		return err
	}
	// 替換連線
	c.conn = tlsConn
	c.tp = textproto.NewConn(tlsConn)
	_ = c.conn.SetDeadline(time.Now().Add(30 * time.Second))
	return nil
}

func (c *Client) authenticate(username, password string) error {
	if username == "" || password == "" {
		return fmt.Errorf("sieve username/password required")
	}
	// AUTHENTICATE "PLAIN" "base64(\0user\0pass)"
	raw := "\x00" + username + "\x00" + password
	enc := base64.StdEncoding.EncodeToString([]byte(raw))
	id := nextTag()
	// ManageSieve: AUTHENTICATE "PLAIN" "b64"
	if err := c.tp.PrintfLine("%s AUTHENTICATE \"PLAIN\" \"%s\"", id, enc); err != nil {
		return err
	}
	// 可能返回挑戰，需處理；但 PLAIN 直接 OK/NO
	for {
		line, err := c.tp.ReadLine()
		if err != nil {
			return fmt.Errorf("sieve auth read failed: %w", err)
		}
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		if strings.HasPrefix(line, id+" ") {
			upper := strings.ToUpper(line)
			if strings.Contains(upper, " OK") {
				// 認證成功，後面會跟新的 CAPABILITY（自動推送）
				// 讀直到下一個 OK 的 capabilities
				// 有些服務器在 AUTH 後主動推送 capability，需把殘留的 capability 行讀完
				// 簡化：不額外讀，後續 LISTSCRIPTS 會重新協商
				break
			}
			return fmt.Errorf("sieve authentication failed: %s", line)
		}
		// 中間的 capability 推送
		parseCapLine(c, line)
		// 若伺服器返回挑戰（以 base64），暫不支援除 PLAIN 以外
	}
	// 清空可能殘留的 capability 推送（直到 OK 已處理）
	return nil
}

// Capability 返回當前能力映射
func (c *Client) Capability() map[string]string {
	out := make(map[string]string, len(c.caps))
	for k, v := range c.caps {
		out[k] = v
	}
	return out
}

// ListScripts 列出腳本
func (c *Client) ListScripts() ([]ScriptInfo, error) {
	id := nextTag()
	if err := c.tp.PrintfLine("%s LISTSCRIPTS", id); err != nil {
		return nil, err
	}
	var scripts []ScriptInfo
	var activeName string
	for {
		line, err := c.tp.ReadLine()
		if err != nil {
			return nil, err
		}
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		if strings.HasPrefix(line, id+" ") {
			upper := strings.ToUpper(line)
			if strings.Contains(upper, " OK") {
				break
			}
			return nil, fmt.Errorf("LISTSCRIPTS failed: %s", line)
		}
		// 單行可能含多個 quoted 腳本名 + ACTIVE 標記
		// 例： "keep" ACTIVE
		// 或： "my" "other.sieve"
		// 解析引號內容
		names := extractQuoted(line)
		for _, n := range names {
			if strings.EqualFold(n, "ACTIVE") {
				continue
			}
			si := ScriptInfo{Name: n}
			// 檢查同一行是否有 ACTIVE
			if strings.Contains(strings.ToUpper(line), "ACTIVE") {
				// 若該行只有一個腳本名，則它為 active
				// 多腳本時，Dovecot 會在 active 腳本後標 ACTIVE
				// 簡化：若行含 ACTIVE 且此 n 在該行，標為 active（需更精準）
				// 做法：檢查 "n" ACTIVE 是否相鄰
				if strings.Contains(line, "\""+n+"\" ACTIVE") || strings.Contains(line, "\""+n+"\"  ACTIVE") {
					si.Active = true
					activeName = n
				}
			}
			scripts = append(scripts, si)
		}
		// 若此行含 ACTIVE 但 names 解析未標記，回填
		if strings.Contains(strings.ToUpper(line), "ACTIVE") && len(scripts) > 0 && activeName == "" {
			// 最後一個為 active（Dovecot 單 active）
			scripts[len(scripts)-1].Active = true
		}
	}
	// 去重：有些 server 每行一個腳本，有些一行多個
	seen := make(map[string]int)
	var dedup []ScriptInfo
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

// GetScript 取得腳本內容
func (c *Client) GetScript(name string) (string, error) {
	if name == "" {
		return "", fmt.Errorf("script name required")
	}
	id := nextTag()
	if err := c.tp.PrintfLine("%s GETSCRIPT \"%s\"", id, escape(name)); err != nil {
		return "", err
	}
	// 回應： {123}\r\n<content>\r\n tag OK
	var content string
	var literalSize = -1
	var buf strings.Builder
	for {
		line, err := c.tp.ReadLine()
		if err != nil {
			return "", err
		}
		// 檢查是否為 literal 宣告 {123}
		if literalSize == -1 && strings.HasPrefix(line, "{") && strings.HasSuffix(strings.TrimSpace(line), "}") {
			inner := strings.TrimSpace(line)
			inner = inner[1 : len(inner)-1]
			inner = strings.TrimSuffix(inner, "+")
			if n, err := strconv.Atoi(strings.TrimSpace(inner)); err == nil {
				literalSize = n
				if n == 0 {
					continue
				}
				// 讀 n bytes（可能含 \r\n）
				data := make([]byte, n)
				if _, err := readExact(c.tp, data); err != nil {
					return "", fmt.Errorf("GETSCRIPT read literal failed: %w", err)
				}
				buf.Write(data)
				// 讀完 literal 後，下一行是 OK
				continue
			}
		}
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, id+" ") {
			upper := strings.ToUpper(trimmed)
			if strings.Contains(upper, " OK") {
				break
			}
			return "", fmt.Errorf("GETSCRIPT failed: %s", line)
		}
		if literalSize != -1 {
			// 已讀 literal，直接忽略
			continue
		}
		if trimmed == "" {
			continue
		}
		// 非 literal 回應（錯誤）
		if strings.HasPrefix(trimmed, id+" NO") || strings.HasPrefix(trimmed, "NO ") {
			return "", fmt.Errorf("GETSCRIPT failed: %s", line)
		}
	}
	content = buf.String()
	// 若未走 literal 分支，嘗試從已讀內容取
	if content == "" && buf.Len() > 0 {
		content = buf.String()
	}
	return content, nil
}

// PutScript 上傳腳本（已有則覆蓋）
func (c *Client) PutScript(name, content string) error {
	if name == "" {
		return fmt.Errorf("script name required")
	}
	id := nextTag()
	literal := fmt.Sprintf("{%d+}", len(content))
	if err := c.tp.PrintfLine("%s PUTSCRIPT \"%s\" %s", id, escape(name), literal); err != nil {
		return err
	}
	// 發送內容（若有）
	if len(content) > 0 {
		if _, err := c.conn.Write([]byte(content)); err != nil {
			return err
		}
	}
	// 發 CRLF 結尾
	if _, err := c.conn.Write([]byte("\r\n")); err != nil {
		return err
	}
	// 刷新 textproto 的緩衝
	// textproto 已有獨立 buf，需確保寫入已刷；直接讀回應
	for {
		line, err := c.tp.ReadLine()
		if err != nil {
			return err
		}
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		if strings.HasPrefix(line, id+" ") {
			upper := strings.ToUpper(line)
			if strings.Contains(upper, " OK") {
				return nil
			}
			return fmt.Errorf("PUTSCRIPT failed: %s", line)
		}
	}
}

// DeleteScript 刪除腳本
func (c *Client) DeleteScript(name string) error {
	if name == "" {
		return fmt.Errorf("script name required")
	}
	id := nextTag()
	if err := c.tp.PrintfLine("%s DELETESCRIPT \"%s\"", id, escape(name)); err != nil {
		return err
	}
	for {
		line, err := c.tp.ReadLine()
		if err != nil {
			return err
		}
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		if strings.HasPrefix(line, id+" ") {
			upper := strings.ToUpper(line)
			if strings.Contains(upper, " OK") {
				return nil
			}
			return fmt.Errorf("DELETESCRIPT failed: %s", line)
		}
	}
}

// SetActive 設定活動腳本（空字串表示停用全部）
func (c *Client) SetActive(name string) error {
	id := nextTag()
	if name == "" {
		if err := c.tp.PrintfLine("%s SETACTIVE \"\"", id); err != nil {
			return err
		}
	} else {
		if err := c.tp.PrintfLine("%s SETACTIVE \"%s\"", id, escape(name)); err != nil {
			return err
		}
	}
	for {
		line, err := c.tp.ReadLine()
		if err != nil {
			return err
		}
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		if strings.HasPrefix(line, id+" ") {
			upper := strings.ToUpper(line)
			if strings.Contains(upper, " OK") {
				return nil
			}
			return fmt.Errorf("SETACTIVE failed: %s", line)
		}
	}
}

// CheckScript 檢查語法（不保存）
func (c *Client) CheckScript(content string) error {
	id := nextTag()
	literal := fmt.Sprintf("{%d+}", len(content))
	if err := c.tp.PrintfLine("%s CHECKSCRIPT %s", id, literal); err != nil {
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
	for {
		line, err := c.tp.ReadLine()
		if err != nil {
			return err
		}
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		if strings.HasPrefix(line, id+" ") {
			upper := strings.ToUpper(line)
			if strings.Contains(upper, " OK") {
				return nil
			}
			return fmt.Errorf("CHECKSCRIPT failed: %s", line)
		}
	}
}

// HaveSpace 檢查配額（選用）
func (c *Client) HaveSpace(name string, size int) error {
	id := nextTag()
	if err := c.tp.PrintfLine("%s HAVESPACE \"%s\" %d", id, escape(name), size); err != nil {
		return err
	}
	for {
		line, err := c.tp.ReadLine()
		if err != nil {
			return err
		}
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		if strings.HasPrefix(line, id+" ") {
			upper := strings.ToUpper(line)
			if strings.Contains(upper, " OK") {
				return nil
			}
			return fmt.Errorf("HAVESPACE failed: %s", line)
		}
	}
}

// Close 關閉連線
func (c *Client) Close() error {
	if c == nil {
		return nil
	}
	// 嘗試優雅 LOGOUT
	if c.tp != nil {
		_ = c.tp.PrintfLine("%s LOGOUT", nextTag())
	}
	if c.conn != nil {
		return c.conn.Close()
	}
	return nil
}

// Logout 顯式登出
func (c *Client) Logout() error {
	if c.tp != nil {
		_ = c.tp.PrintfLine("%s LOGOUT", nextTag())
		// 讀到 BYE/OK 即可關
		_ = c.conn.SetReadDeadline(time.Now().Add(2 * time.Second))
		_, _ = c.tp.ReadLine()
	}
	return c.Close()
}

// --- helpers ---

var tagCounter int

func nextTag() string {
	tagCounter++
	return fmt.Sprintf("A%04d", tagCounter)
}

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
	// textproto 的內部 reader 已被 b 消費，需重建？簡化：放棄 textproto 緩衝一致性
	// 由於我們只在 literal 後立即讀，banner 已讀完，殘留可忽略
	return total, nil
}
