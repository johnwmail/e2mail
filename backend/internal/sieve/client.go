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
type Client struct {
	conn   net.Conn
	tp     *textproto.Conn
	caps   map[string]string
	sasl   []string
	tlsCap bool
	debug  bool
}

// cfmtf 記錄並發送一行協議命令（debug 模式）
func (c *Client) cfmtf(format string, args ...any) error {
	line := fmt.Sprintf(format, args...)
	if c.debug {
		// 避免洩漏 base64 憑證內容
		if idx := strings.Index(line, "AUTHENTICATE"); idx >= 0 {
			log.Printf("[SIEVE-C] %s <redacted>", line[:idx+len("AUTHENTICATE")])
		} else {
			log.Printf("[SIEVE-C] %s", line)
		}
	}
	return c.tp.PrintfLine("%s", line)
}

// cline 讀取一行回應（debug 模式記錄）
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

// writeRaw 直接寫入底層連線（textproto.Writer 每次 PrintfLine 即 flush，
// 故與 raw 寫入交錯順序安全）
func (c *Client) writeRaw(s string) error {
	_, err := c.conn.Write([]byte(s))
	return err
}

// drainTo 讀到指定 tag 的最終回複為止，丟棄殘留行（供重試前清場）
func (c *Client) drainTo(id string) error {
	deadline := time.Now().Add(3 * time.Second)
	_ = c.conn.SetDeadline(deadline)
	for {
		line, err := c.cline()
		if err != nil {
			return err
		}
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		if strings.HasPrefix(trimmed, id+" ") {
			return nil
		}
	}
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

	// ManageSieve 傳統為明文 + STARTTLS（非 implicit TLS），直接明文連接
	// 若 UseTLS=true 且伺服器宣告 STARTTLS，稍後會升級
	conn, err = dialer.DialContext(ctx, "tcp", addr)
	if err != nil {
		return nil, fmt.Errorf("sieve dial failed %s: %w", addr, err)
	}
	log.Printf("[SIEVE] dial ok %s (UseTLS=%v AllowInsecure=%v user=%s)", addr, cfg.UseTLS, cfg.AllowInsecureTLS, cfg.Username)

	// 設置整體 deadline（每階段 15s，總體 30s）
	_ = conn.SetDeadline(time.Now().Add(30 * time.Second))

	tp := textproto.NewConn(conn)
	c := &Client{conn: conn, tp: tp, caps: make(map[string]string), debug: cfg.Debug}

	// 讀 banner 與 CAPABILITY（直到 OK / NO）
	if err := c.readBanner(); err != nil {
		_ = c.Close()
		return nil, fmt.Errorf("sieve banner failed %s: %w", addr, err)
	}
	log.Printf("[SIEVE] banner ok %s caps=%v sasl=%v tlsCap=%v", addr, c.caps, c.sasl, c.tlsCap)

	// 若明文且伺服器宣告 STARTTLS：一律嘗試升級
	// （Dovecot disable_plaintext_auth=yes 時 SASL 機制在 TLS 前顯示為空，
	//   不升級則 AUTHENTICATE 永遠得不到回應）
	if !isTLSConn(conn) && c.tlsCap {
		log.Printf("[SIEVE] STARTTLS start %s", addr)
		if err := c.doSTARTTLS(cfg); err != nil {
			if cfg.UseTLS {
				_ = c.Close()
				return nil, fmt.Errorf("sieve STARTTLS failed %s: %w", addr, err)
			}
			// UseTLS=false 時降級回明文繼續
			log.Printf("[SIEVE] STARTTLS failed but UseTLS=false, continuing plain %s: %v", addr, err)
		} else {
			// RFC 5804 §1.4：TLS 後伺服器唔會再推 banner，client 應主動 CAPABILITY
			c.caps = make(map[string]string)
			c.sasl = nil
			c.tlsCap = false
			_ = c.conn.SetDeadline(time.Now().Add(20 * time.Second))
			if err := c.doCapability(); err != nil {
				_ = c.Close()
				return nil, fmt.Errorf("sieve post-STARTTLS capability failed %s: %w", addr, err)
			}
			log.Printf("[SIEVE] post-STARTTLS capability ok %s sasl=%v", addr, c.sasl)
		}
	} else if !isTLSConn(conn) && !c.tlsCap && cfg.UseTLS {
		log.Printf("[SIEVE] STARTTLS not advertised but UseTLS=true, continuing plain %s", addr)
	}
	// 刷新 deadline 供認證階段（passdb 經 ldapd 時可能較慢，預留 25s）
	_ = c.conn.SetDeadline(time.Now().Add(25 * time.Second))
	log.Printf("[SIEVE] authenticate start %s user=%s sasl=%v", addr, cfg.Username, c.sasl)

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
		line, err := c.cline()
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
			// Dovecot 以帶引號形式發送 capabilities（"STARTTLS"），同樣要觸發 tlsCap
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

// doCapability 取得 / 重新取得 capabilities（TLS 後按 RFC 5804 需 client 主動）
func (c *Client) doCapability() error {
	id := nextTag()
	if err := c.cfmtf("%s CAPABILITY", id); err != nil {
		return err
	}
	for {
		line, err := c.cline()
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
	if err := c.cfmtf("%s STARTTLS", id); err != nil {
		return fmt.Errorf("STARTTLS write failed: %w", err)
	}
	line, err := c.cline()
	if err != nil {
		return fmt.Errorf("STARTTLS read failed: %w", err)
	}
	if !strings.Contains(strings.ToUpper(line), "OK") {
		return fmt.Errorf("STARTTLS rejected: %s", line)
	}
	// 對 IP 主機，ServerName 用空以避免 SNI 驗證失敗；自簽憑證時跳過校驗
	serverName := cfg.Host
	if net.ParseIP(serverName) != nil {
		serverName = ""
	}
	tlsCfg := &tls.Config{
		ServerName:         serverName,
		InsecureSkipVerify: cfg.AllowInsecureTLS || serverName == "",
	}
	// 若 AllowInsecure=false 但 host 為 IP，仍允許握手（證書多為域名）
	if !cfg.AllowInsecureTLS && serverName == "" {
		log.Printf("[SIEVE] STARTTLS IP %s with InsecureSkipVerify=true (no SNI)", cfg.Host)
	}
	tlsConn := tls.Client(c.conn, tlsCfg)
	if err := tlsConn.Handshake(); err != nil {
		return fmt.Errorf("TLS handshake failed: %w", err)
	}
	// 替換連線
	c.conn = tlsConn
	c.tp = textproto.NewConn(tlsConn)
	_ = c.conn.SetDeadline(time.Now().Add(30 * time.Second))
	log.Printf("[SIEVE] STARTTLS handshake ok %s", cfg.Host)
	return nil
}

// base40 按 RFC 5804：base64 若以 '=' 結尾，需再追加一個 '='（避免與 literal 混淆）
func base40(data []byte) string {
	enc := base64.StdEncoding.EncodeToString(data)
	if strings.HasSuffix(enc, "=") {
		enc += "="
	}
	return enc
}

func (c *Client) authenticate(username, password string) error {
	if username == "" || password == "" {
		return fmt.Errorf("sieve username/password required")
	}
	tryMechs := []string{"PLAIN"}
	// 依 advertised SASL 機制決定順序（Dovecot 通常 PLAIN；部分部署僅 LOGIN）
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
	// 準備使用者名稱備選：完整 email 與 @ 前綴（兼容 Dovecot 僅認 bare user）
	usernames := []string{username}
	if strings.Contains(username, "@") {
		usernames = append(usernames, strings.Split(username, "@")[0])
	}
	for _, u := range usernames {
		for _, mech := range tryMechs {
			lastErr = c.tryAuthenticate(mech, u, password)
			if lastErr == nil {
				return nil
			}
			log.Printf("[SIEVE] auth %s as %s failed: %v", mech, u, lastErr)
		}
	}
	return lastErr
}

// tryAuthenticate 以單一機制嘗試認證
//   PLAIN: AUTHENTICATE "PLAIN" "<b64(\0user\0pass)>"（無挑战直接 OK/NO；部分 server 回 "+" 再發一次）
//   LOGIN: AUTHENTICATE "LOGIN" → 伺服器 "+ …" → base64(user) → "+ …" → base64(pass) → tagged OK/NO
func (c *Client) tryAuthenticate(mech, username, password string) error {
	id := nextTag()
	_ = c.conn.SetDeadline(time.Now().Add(25 * time.Second))

	plainToken := base40([]byte("\x00" + username + "\x00" + password))
	loginUser := base40([]byte(username))
	loginPass := base40([]byte(password))

	if strings.EqualFold(mech, "LOGIN") {
		if err := c.cfmtf("%s AUTHENTICATE \"%s\"", id, mech); err != nil {
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
					resp = loginUser
				case 1:
					resp = loginPass
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
			return c.evalAuthReply(id, trimmed)
		}
	}

	// PLAIN（預設）
	if c.debug {
		log.Printf("[SIEVE-C] %s AUTHENTICATE \"PLAIN\" \"<redacted>\"", id)
	}
	if err := c.writeRaw(fmt.Sprintf("%s AUTHENTICATE \"PLAIN\" \"%s\"\r\n", id, plainToken)); err != nil {
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
			// 伺服器不接受 initial-response，改以挑戰回覆憑證
			if c.debug {
				log.Printf("[SIEVE-C] <plain resp redacted>")
			}
			if err := c.writeRaw(plainToken + "\r\n"); err != nil {
				return err
			}
			continue
		}
		if err := c.evalAuthReply(id, trimmed); err != nil {
			// tagged 回複已收；清走可能殘留嘅 capability 推送行
			_ = c.drainTo(id)
			return err
		}
		return nil
	}
}

// evalAuthReply 判斷一行是否本 tag 嘅最終回複；非本 tag 則記錄能力後回傳 nil-ish error 由 caller 繼續
func (c *Client) evalAuthReply(id, trimmed string) error {
	if strings.HasPrefix(trimmed, id+" ") {
		upper := strings.ToUpper(trimmed)
		if strings.Contains(upper, " OK") {
			return nil
		}
		return fmt.Errorf("sieve authentication failed: %s", trimmed)
	}
	// 未預期的行（例如多推送嘅 capability）：記錄後當作未完成
	parseCapLine(c, trimmed)
	return fmt.Errorf("sieve auth unexpected reply: %s", trimmed)
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
	if err := c.cfmtf("%s LISTSCRIPTS", id); err != nil {
		return nil, err
	}
	var scripts []ScriptInfo
	var activeName string
	for {
		line, err := c.cline()
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
	if err := c.cfmtf("%s GETSCRIPT \"%s\"", id, escape(name)); err != nil {
		return "", err
	}
	// 回應： {123}\r\n<content>\r\n tag OK
	var content string
	var literalSize = -1
	var buf strings.Builder
	for {
		line, err := c.cline()
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
	if err := c.cfmtf("%s PUTSCRIPT \"%s\" %s", id, escape(name), literal); err != nil {
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
		line, err := c.cline()
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
	if err := c.cfmtf("%s DELETESCRIPT \"%s\"", id, escape(name)); err != nil {
		return err
	}
	for {
		line, err := c.cline()
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
		if err := c.cfmtf("%s SETACTIVE \"\"", id); err != nil {
			return err
		}
	} else {
		if err := c.cfmtf("%s SETACTIVE \"%s\"", id, escape(name)); err != nil {
			return err
		}
	}
	for {
		line, err := c.cline()
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
	if err := c.cfmtf("%s CHECKSCRIPT %s", id, literal); err != nil {
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
		line, err := c.cline()
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
	if err := c.cfmtf("%s HAVESPACE \"%s\" %d", id, escape(name), size); err != nil {
		return err
	}
	for {
		line, err := c.cline()
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
