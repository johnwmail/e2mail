package smtp

import (
	"bytes"
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"mime"
	netmail "net/mail"
	netsmtp "net/smtp"
	"strings"
	"time"

	gomail "github.com/emersion/go-message/mail"
)

// SMTPConfig 發信連線設定
type SMTPConfig struct {
	Host             string
	Port             int
	UseTLS           bool
	AllowInsecureTLS bool
	Username         string
	Password         string
}

// TestSMTPConnection 只測試 SMTP 連線 + 認證（唔發送任何郵件）
func TestSMTPConnection(ctx context.Context, config SMTPConfig) error {
	addr := fmt.Sprintf("%s:%d", config.Host, config.Port)
	tlsConfig := &tls.Config{
		ServerName:         config.Host,
		InsecureSkipVerify: config.AllowInsecureTLS,
	}

	var client *netsmtp.Client

	if config.Port == 465 {
		conn, err := tls.Dial("tcp", addr, tlsConfig)
		if err != nil {
			return fmt.Errorf("SMTP SSL dial failed to %s: %w", addr, err)
		}
		defer func() { _ = conn.Close() }()
		client, err = netsmtp.NewClient(conn, config.Host)
		if err != nil {
			return fmt.Errorf("SMTP SSL client init failed: %w", err)
		}
	} else {
		c, err := netsmtp.Dial(addr)
		if err != nil {
			return fmt.Errorf("SMTP connection failed to %s: %w", addr, err)
		}
		client = c
		if ok, _ := client.Extension("STARTTLS"); ok {
			if err := client.StartTLS(tlsConfig); err != nil {
				_ = client.Close()
				return fmt.Errorf("SMTP STARTTLS negotiation failed on %s: %w", addr, err)
			}
		}
	}
	defer func() { _ = client.Quit() }()

	// 驗證認證
	if config.Username != "" && config.Password != "" {
		if ok, mech := client.Extension("AUTH"); ok {
			mechUpper := strings.ToUpper(mech)
			if strings.Contains(mechUpper, "PLAIN") {
				if err := client.Auth(netsmtp.PlainAuth("", config.Username, config.Password, config.Host)); err != nil {
					return fmt.Errorf("SMTP authentication failed: %w", err)
				}
			} else if strings.Contains(mechUpper, "LOGIN") {
				if err := client.Auth(LoginAuth(config.Username, config.Password)); err != nil {
					return fmt.Errorf("SMTP authentication failed: %w", err)
				}
			} else {
				if err := client.Auth(netsmtp.PlainAuth("", config.Username, config.Password, config.Host)); err != nil {
					if err2 := client.Auth(LoginAuth(config.Username, config.Password)); err2 != nil {
						return fmt.Errorf("SMTP authentication failed: %w", err2)
					}
				}
			}
		}
	}
	return nil
}

// OutgoingAttachment 寄信附件
type OutgoingAttachment struct {
	Filename    string `json:"filename"`
	ContentType string `json:"contentType"`
	Data        []byte `json:"-"`
}

// OutgoingMessage 待發送之郵件內容
type OutgoingMessage struct {
	From        string               `json:"from"`
	To          []string             `json:"to"`
	Cc          []string             `json:"cc"`
	Bcc         []string             `json:"bcc"`
	Subject     string               `json:"subject"`
	InReplyTo   string               `json:"inReplyTo,omitempty"`
	References  string               `json:"references,omitempty"`
	TextBody    string               `json:"textBody"`
	HTMLBody    string               `json:"htmlBody"`
	Attachments []OutgoingAttachment `json:"attachments"`
}

// Sender SMTP 郵件發送器
type Sender struct{}

// NewSender 建立發送器實例
func NewSender() *Sender {
	return &Sender{}
}

// loginAuth 實作 AUTH LOGIN 認證機制（廣泛相容 Exchange/Outlook/Dovecot/Postfix）
type loginAuth struct {
	username string
	password string
}

func LoginAuth(username, password string) netsmtp.Auth {
	return &loginAuth{username: username, password: password}
}

func (a *loginAuth) Start(server *netsmtp.ServerInfo) (string, []byte, error) {
	return "LOGIN", []byte{}, nil
}

func (a *loginAuth) Next(fromServer []byte, more bool) ([]byte, error) {
	if more {
		serverPrompt := strings.TrimSpace(strings.ToLower(string(fromServer)))
		if strings.HasPrefix(serverPrompt, "username:") || strings.HasPrefix(serverPrompt, "user:") || strings.Contains(serverPrompt, "334 vxnlcm5hbwu6") {
			return []byte(a.username), nil
		}
		if strings.HasPrefix(serverPrompt, "password:") || strings.HasPrefix(serverPrompt, "pass:") || strings.Contains(serverPrompt, "334 ugfzc3dvcmq6") {
			return []byte(a.password), nil
		}
		// 預設第 1 次 Challenge 給帳號，第 2 次給密碼
		return []byte(a.username), nil
	}
	return nil, nil
}

// extractBareEmail 提取純淨 Email 地址 (例如 "John <john@example.com>" -> "john@example.com")
func extractBareEmail(raw string) string {
	raw = strings.TrimSpace(raw)
	if parsed, err := netmail.ParseAddress(raw); err == nil && parsed != nil && parsed.Address != "" {
		return parsed.Address
	}
	if start := strings.Index(raw, "<"); start >= 0 {
		if end := strings.Index(raw, ">"); end > start {
			return strings.TrimSpace(raw[start+1 : end])
		}
	}
	return strings.Trim(raw, "<> \t\r\n")
}

// BuildMIMEMessage 組裝 RFC 5322 MIME 郵件資料
func (s *Sender) BuildMIMEMessage(msg OutgoingMessage) ([]byte, error) {
	var buf bytes.Buffer

	var h gomail.Header
	h.SetDate(time.Now())
	h.SetSubject(msg.Subject)

	// 設定 From
	fromAddr, err := netmail.ParseAddress(msg.From)
	if err == nil {
		h.SetAddressList("From", []*netmail.Address{fromAddr})
	} else {
		h.Set("From", msg.From)
	}

	// 設定 To, Cc, Bcc
	var toList []*netmail.Address
	for _, a := range msg.To {
		if parsed, err := netmail.ParseAddress(a); err == nil {
			toList = append(toList, parsed)
		}
	}
	if len(toList) > 0 {
		h.SetAddressList("To", toList)
	}

	var ccList []*netmail.Address
	for _, a := range msg.Cc {
		if parsed, err := netmail.ParseAddress(a); err == nil {
			ccList = append(ccList, parsed)
		}
	}
	if len(ccList) > 0 {
		h.SetAddressList("Cc", ccList)
	}

	if msg.InReplyTo != "" {
		h.Set("In-Reply-To", msg.InReplyTo)
	}
	if msg.References != "" {
		h.Set("References", msg.References)
	}

	// 建立 Mail Writer
	mw, err := gomail.CreateWriter(&buf, h)
	if err != nil {
		return nil, fmt.Errorf("failed to create mail writer: %w", err)
	}

	isPgp := strings.Contains(msg.TextBody, "-----BEGIN PGP")

	// 處理正文 (multipart/alternative 或 7bit 純文字 PGP 區塊)
	if !isPgp && msg.HTMLBody != "" && msg.TextBody != "" {
		// 雙格式支援
		tw, err := mw.CreateInline()
		if err != nil {
			return nil, err
		}

		var textHeader gomail.InlineHeader
		textHeader.Set("Content-Type", "text/plain; charset=UTF-8")
		wText, err := tw.CreatePart(textHeader)
		if err != nil {
			return nil, err
		}
		_, _ = io.WriteString(wText, msg.TextBody)
		_ = wText.Close()

		var htmlHeader gomail.InlineHeader
		htmlHeader.Set("Content-Type", "text/html; charset=UTF-8")
		wHtml, err := tw.CreatePart(htmlHeader)
		if err != nil {
			return nil, err
		}
		_, _ = io.WriteString(wHtml, msg.HTMLBody)
		_ = wHtml.Close()
		_ = tw.Close()
	} else if !isPgp && msg.HTMLBody != "" {
		var htmlHeader gomail.InlineHeader
		htmlHeader.Set("Content-Type", "text/html; charset=UTF-8")
		wHtml, err := mw.CreateSingleInline(htmlHeader)
		if err != nil {
			return nil, err
		}
		_, _ = io.WriteString(wHtml, msg.HTMLBody)
		_ = wHtml.Close()
	} else {
		// PGP 郵件或純文字郵件：強制使用 7bit 傳輸編碼，防止 Quoted-Printable 破壞 PGP ASCII 換行與 CRC Checksum
		var textHeader gomail.InlineHeader
		textHeader.Set("Content-Type", "text/plain; charset=UTF-8")
		textHeader.Set("Content-Transfer-Encoding", "7bit")
		wText, err := mw.CreateSingleInline(textHeader)
		if err != nil {
			return nil, err
		}
		normalizedBody := strings.ReplaceAll(msg.TextBody, "\r\n", "\n")
		normalizedBody = strings.ReplaceAll(normalizedBody, "\n", "\r\n")
		_, _ = io.WriteString(wText, normalizedBody)
		_ = wText.Close()
	}

	// 處理附件
	for _, att := range msg.Attachments {
		var attHeader gomail.AttachmentHeader
		cType := att.ContentType
		if cType == "" {
			cType = "application/octet-stream"
		}
		attHeader.Set("Content-Type", cType)
		attHeader.SetFilename(mime.QEncoding.Encode("utf-8", att.Filename))

		wAtt, err := mw.CreateAttachment(attHeader)
		if err != nil {
			return nil, err
		}
		_, _ = wAtt.Write(att.Data)
		_ = wAtt.Close()
	}

	if err := mw.Close(); err != nil {
		return nil, fmt.Errorf("failed to close mail writer: %w", err)
	}

	return buf.Bytes(), nil
}

// Send 透過 SMTP 發送郵件
func (s *Sender) Send(ctx context.Context, config SMTPConfig, msg OutgoingMessage) error {
	rawMIME, err := s.BuildMIMEMessage(msg)
	if err != nil {
		return fmt.Errorf("failed to build MIME message: %w", err)
	}

	// 提取純淨信封發件人
	fromBare := extractBareEmail(msg.From)
	if fromBare == "" {
		return errors.New("sender (from) address is invalid or empty")
	}

	// 提取純淨信封收件人清單 (To + Cc + Bcc)
	var allRecipients []string
	allRecipients = append(allRecipients, msg.To...)
	allRecipients = append(allRecipients, msg.Cc...)
	allRecipients = append(allRecipients, msg.Bcc...)

	var cleanRecipients []string
	for _, r := range allRecipients {
		bare := extractBareEmail(r)
		if bare != "" {
			cleanRecipients = append(cleanRecipients, bare)
		}
	}

	if len(cleanRecipients) == 0 {
		return errors.New("no valid recipient addresses specified")
	}

	addr := fmt.Sprintf("%s:%d", config.Host, config.Port)
	tlsConfig := &tls.Config{
		ServerName:         config.Host,
		InsecureSkipVerify: config.AllowInsecureTLS,
	}

	var client *netsmtp.Client

	// 1. 連線協定判斷：只有 Port 465 採用直接 SMTPS (Implicit TLS)
	if config.Port == 465 {
		conn, err := tls.Dial("tcp", addr, tlsConfig)
		if err != nil {
			return fmt.Errorf("SMTP SSL dial failed to %s: %w", addr, err)
		}
		defer func() { _ = conn.Close() }()

		client, err = netsmtp.NewClient(conn, config.Host)
		if err != nil {
			return fmt.Errorf("SMTP SSL client init failed: %w", err)
		}
	} else {
		// Port 587, 25 或其他端口：先建立一般連線，再透過 STARTTLS 協商升級
		c, err := netsmtp.Dial(addr)
		if err != nil {
			return fmt.Errorf("SMTP connection failed to %s: %w", addr, err)
		}
		client = c

		// 檢查並執行 STARTTLS
		if ok, _ := client.Extension("STARTTLS"); ok {
			if err := client.StartTLS(tlsConfig); err != nil {
				_ = client.Close()
				return fmt.Errorf("SMTP STARTTLS negotiation failed on %s: %w", addr, err)
			}
		}
	}
	defer func() { _ = client.Quit() }()

	// 2. 身分驗證 (支援 PLAIN 與 LOGIN 自動適配)
	if config.Username != "" && config.Password != "" {
		if ok, mech := client.Extension("AUTH"); ok {
			mechUpper := strings.ToUpper(mech)
			var authErr error

			if strings.Contains(mechUpper, "PLAIN") {
				authErr = client.Auth(netsmtp.PlainAuth("", config.Username, config.Password, config.Host))
			} else if strings.Contains(mechUpper, "LOGIN") {
				authErr = client.Auth(LoginAuth(config.Username, config.Password))
			} else {
				// 預設嘗試 PLAIN，若失敗自動回退至 LOGIN
				authErr = client.Auth(netsmtp.PlainAuth("", config.Username, config.Password, config.Host))
				if authErr != nil {
					authErr = client.Auth(LoginAuth(config.Username, config.Password))
				}
			}

			if authErr != nil {
				return fmt.Errorf("SMTP authentication failed for user %s: %w", config.Username, authErr)
			}
		}
	}

	// 3. 信封寄件者 (MAIL FROM)
	if err := client.Mail(fromBare); err != nil {
		return fmt.Errorf("SMTP MAIL FROM <%s> rejected by server: %w", fromBare, err)
	}

	// 4. 信封收件者 (RCPT TO)
	for _, rcpt := range cleanRecipients {
		if err := client.Rcpt(rcpt); err != nil {
			return fmt.Errorf("SMTP RCPT TO <%s> rejected by server: %w", rcpt, err)
		}
	}

	// 5. 寫入郵件資料 (DATA)
	w, err := client.Data()
	if err != nil {
		return fmt.Errorf("SMTP DATA command failed: %w", err)
	}

	if _, err := w.Write(rawMIME); err != nil {
		_ = w.Close()
		return fmt.Errorf("SMTP write mail body failed: %w", err)
	}

	if err := w.Close(); err != nil {
		return fmt.Errorf("SMTP finish DATA failed: %w", err)
	}

	return nil
}
