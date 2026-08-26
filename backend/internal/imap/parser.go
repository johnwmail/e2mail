package imap

import (
	"bytes"
	"fmt"
	"io"
	"strings"
	"time"

	gomail "github.com/emersion/go-message/mail"
	"github.com/johnwmail/e2mail/backend/pkg/charsetutil"
)

// EmailAddress 封裝電子郵件地址與顯示名稱
type EmailAddress struct {
	Name    string `json:"name"`
	Address string `json:"address"`
}

// AttachmentInfo 附件結構定義
type AttachmentInfo struct {
	ID          string `json:"id"`
	Filename    string `json:"filename"`
	ContentType string `json:"contentType"`
	Size        int64  `json:"size"`
	ContentID   string `json:"contentId,omitempty"`
	IsInline    bool   `json:"isInline"`
	Data        []byte `json:"-"` // 下載時使用
}

// ParsedMessage 完整郵件結構
type ParsedMessage struct {
	UID         uint32           `json:"uid"`
	MessageID   string           `json:"messageId"`
	Subject     string           `json:"subject"`
	Date        time.Time        `json:"date"`
	From        []EmailAddress   `json:"from"`
	To          []EmailAddress   `json:"to"`
	Cc          []EmailAddress   `json:"cc"`
	Bcc         []EmailAddress   `json:"bcc"`
	ReplyTo     []EmailAddress   `json:"replyTo"`
	Flags       []string         `json:"flags"`
	Unread      bool             `json:"unread"`
	Starred     bool             `json:"starred"`
	Answered    bool             `json:"answered"`
	TextBody    string           `json:"textBody"`
	HTMLBody    string           `json:"htmlBody"`
	Attachments []AttachmentInfo `json:"attachments"`
	Size        uint32           `json:"size"`
}

// MessageSummary 郵件列表摘要結構
type MessageSummary struct {
	UID         uint32         `json:"uid"`
	MessageID   string         `json:"messageId"`
	Subject     string         `json:"subject"`
	Date        time.Time      `json:"date"`
	From        []EmailAddress `json:"from"`
	To          []EmailAddress `json:"to"`
	Flags       []string       `json:"flags"`
	Unread      bool           `json:"unread"`
	Starred     bool           `json:"starred"`
	HasAttachment bool         `json:"hasAttachment"`
	Size        uint32         `json:"size"`
	Snippet     string         `json:"snippet"`
}

// ParseAddressList 解析郵件地址清單並解碼 RFC 2047 字元
func ParseAddressList(rawList []*gomail.Address) []EmailAddress {
	var result []EmailAddress
	for _, addr := range rawList {
		if addr == nil {
			continue
		}
		result = append(result, EmailAddress{
			Name:    charsetutil.DecodeHeader(addr.Name),
			Address: addr.Address,
		})
	}
	return result
}

// ParseHeaderAddresses 解析單一字串為地址陣列
func ParseHeaderAddresses(raw string) []EmailAddress {
	if raw == "" {
		return []EmailAddress{}
	}
	parsed, err := gomail.ParseAddressList(raw)
	if err != nil {
		return []EmailAddress{{Address: raw}}
	}
	return ParseAddressList(parsed)
}

// ParseRFC822 解析 RFC 822 郵件內文與附件結構
func ParseRFC822(raw []byte) (string, string, []AttachmentInfo, error) {
	msg, err := ParseRFC822Message(raw, 0, nil)
	if err != nil {
		return "", "", nil, err
	}
	return msg.TextBody, msg.HTMLBody, msg.Attachments, nil
}

// ParseRFC822Message 解析 RFC 822 完整郵件位元組資料
func ParseRFC822Message(raw []byte, uid uint32, flags []string) (*ParsedMessage, error) {
	msg := &ParsedMessage{
		UID:         uid,
		Flags:       flags,
		Attachments: make([]AttachmentInfo, 0),
	}

	populateFlags(msg, flags)

	mr, err := gomail.CreateReader(bytes.NewReader(raw))
	if err != nil {
		return nil, fmt.Errorf("failed to create mail reader: %w", err)
	}

	populateHeaders(msg, mr.Header)

	topContentType, topParams, _ := mr.Header.ContentType()
	isPgpMime := strings.HasPrefix(topContentType, "multipart/encrypted") && strings.EqualFold(topParams["protocol"], "application/pgp-encrypted")

	if err := collectParts(msg, mr); err != nil {
		return nil, err
	}

	handlePgpMime(msg, isPgpMime)

	return msg, nil
}

func populateFlags(msg *ParsedMessage, flags []string) {
	for _, f := range flags {
		fUpper := strings.ToUpper(f)
		if fUpper == `\FLAGGED` {
			msg.Starred = true
		}
		if fUpper == `\ANSWERED` {
			msg.Answered = true
		}
	}
	msg.Unread = !containsFlag(flags, `\Seen`)
}

func populateHeaders(msg *ParsedMessage, header gomail.Header) {
	if subject, err := header.Subject(); err == nil {
		msg.Subject = charsetutil.DecodeHeader(subject)
	}
	if date, err := header.Date(); err == nil {
		msg.Date = date
	}
	if msgID, err := header.MessageID(); err == nil {
		msg.MessageID = msgID
	}
	if fromList, err := header.AddressList("From"); err == nil {
		msg.From = ParseAddressList(fromList)
	}
	if toList, err := header.AddressList("To"); err == nil {
		msg.To = ParseAddressList(toList)
	}
	if ccList, err := header.AddressList("Cc"); err == nil {
		msg.Cc = ParseAddressList(ccList)
	}
	if bccList, err := header.AddressList("Bcc"); err == nil {
		msg.Bcc = ParseAddressList(bccList)
	}
	if replyToList, err := header.AddressList("Reply-To"); err == nil {
		msg.ReplyTo = ParseAddressList(replyToList)
	}
}

func collectParts(msg *ParsedMessage, mr *gomail.Reader) error {
	attachmentIndex := 0
	for {
		part, err := mr.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			break
		}
		switch h := part.Header.(type) {
		case *gomail.InlineHeader:
			handleInlinePart(msg, h, part)
		case *gomail.AttachmentHeader:
			attachmentIndex++
			handleAttachmentPart(msg, h, part, attachmentIndex)
		}
	}
	return nil
}

func handleInlinePart(msg *ParsedMessage, h *gomail.InlineHeader, part *gomail.Part) {
	contentType, params, _ := h.ContentType()
	charsetParam := params["charset"]
	bodyBytes, _ := io.ReadAll(part.Body)
	utf8Body, _ := charsetutil.ToUTF8(bodyBytes, charsetParam)
	if strings.HasPrefix(contentType, "text/plain") && msg.TextBody == "" {
		msg.TextBody = utf8Body
	} else if strings.HasPrefix(contentType, "text/html") && msg.HTMLBody == "" {
		msg.HTMLBody = utf8Body
	} else {
		// Non-text inline content (e.g. PGP/MIME application/octet-stream with Content-Disposition: inline)
		// 保留為附件，令 handlePgpMime 可以抽取 PGP 訊息
		var filename string
		if _, dispParams, _ := h.ContentDisposition(); dispParams != nil {
			filename = dispParams["filename"]
		}
		if filename == "" {
			filename = params["name"]
		}
		if filename == "" {
			filename = fmt.Sprintf("inline_%d", len(msg.Attachments)+1)
		}
		filename = charsetutil.DecodeHeader(filename)
		contentID := strings.Trim(h.Get("Content-Id"), "<>")
		att := AttachmentInfo{
			ID:          fmt.Sprintf("%d", len(msg.Attachments)+1),
			Filename:    filename,
			ContentType: contentType,
			Size:        int64(len(bodyBytes)),
			ContentID:   contentID,
			IsInline:    true,
			Data:        bodyBytes,
		}
		msg.Attachments = append(msg.Attachments, att)
	}
}

func handleAttachmentPart(msg *ParsedMessage, h *gomail.AttachmentHeader, part *gomail.Part, idx int) {
	contentType, _, _ := h.ContentType()
	filename, _ := h.Filename()
	if filename == "" {
		filename = fmt.Sprintf("attachment_%d", idx)
	}
	filename = charsetutil.DecodeHeader(filename)
	contentID := strings.Trim(h.Get("Content-Id"), "<>")
	isInline := strings.EqualFold(h.Get("Content-Disposition"), "inline") || contentID != ""
	data, _ := io.ReadAll(part.Body)
	att := AttachmentInfo{
		ID:          fmt.Sprintf("%d", idx),
		Filename:    filename,
		ContentType: contentType,
		Size:        int64(len(data)),
		ContentID:   contentID,
		IsInline:    isInline,
		Data:        data,
	}
	msg.Attachments = append(msg.Attachments, att)
}

func handlePgpMime(msg *ParsedMessage, isPgpMime bool) {
	if !isPgpMime && (msg.TextBody != "" || msg.HTMLBody != "") {
		return
	}
	for i, att := range msg.Attachments {
		if strings.Contains(string(att.Data), "-----BEGIN PGP MESSAGE-----") {
			if msg.TextBody == "" {
				msg.TextBody = string(att.Data)
			}
			msg.Attachments = append(msg.Attachments[:i], msg.Attachments[i+1:]...)
			break
		}
	}
	filtered := msg.Attachments[:0]
	for _, att := range msg.Attachments {
		if strings.EqualFold(att.ContentType, "application/pgp-encrypted") && strings.TrimSpace(string(att.Data)) == "Version: 1" {
			continue
		}
		filtered = append(filtered, att)
	}
	msg.Attachments = filtered
}

func containsFlag(flags []string, target string) bool {
	for _, f := range flags {
		if strings.EqualFold(f, target) {
			return true
		}
	}
	return false
}
