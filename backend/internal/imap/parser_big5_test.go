package imap

import (
	"bytes"
	"encoding/base64"
	"os"
	"testing"
	"unicode/utf8"

	"golang.org/x/text/encoding/traditionalchinese"
	"golang.org/x/text/transform"
)

func big5s(s string) []byte {
	b, _, _ := transform.Bytes(traditionalchinese.Big5.NewEncoder(), []byte(s))
	return b
}

func quotedPrintable(b []byte) string {
	var out bytes.Buffer
	const hex = "0123456789ABCDEF"
	for _, c := range b {
		if c > 32 && c < 127 && c != '=' {
			out.WriteByte(c)
		} else {
			out.WriteByte('=')
			out.WriteByte(hex[c>>4])
			out.WriteByte(hex[c&0x0F])
		}
	}
	return out.String()
}

// Big5（非 UTF-8）multipart/alternative 郵件：本專案嘅 charsetutil 已註冊為
// go-message CharsetReader，佢必須正確解碼 subject 同 text/plain、text/html body。
func TestParseRFC822Big5Alternative(t *testing.T) {
	raw := buildBig5Message()
	msg, err := ParseRFC822Message(raw, 1, nil)
	if err != nil {
		t.Fatalf("parse error: %v", err)
	}
	if msg.Subject != "測試" {
		t.Fatalf("subject = %q, want 測試", msg.Subject)
	}
	if msg.TextBody != "你好" {
		t.Fatalf("text = %q, want 你好", msg.TextBody)
	}
	if msg.HTMLBody != "你好" {
		t.Fatalf("html = %q, want 你好", msg.HTMLBody)
	}
	for i, s := range []string{msg.Subject, msg.TextBody, msg.HTMLBody} {
		if !utf8.ValidString(s) {
			t.Fatalf("output %d not valid utf-8", i)
		}
	}
}

// 回歸：真實用戶回報嘅 Big5 auto-reply（曾有「此郵件無內文」）必須解出 body。
func TestParseRFC822Big5RealFixture(t *testing.T) {
	raw, err := os.ReadFile("testdata/big5_alternative.eml")
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	msg, err := ParseRFC822Message(raw, 2, nil)
	if err != nil {
		t.Fatalf("parse error: %v", err)
	}
	if msg.Subject == "" {
		t.Fatal("subject is empty")
	}
	if msg.TextBody == "" {
		t.Fatal("text body is empty")
	}
	if msg.HTMLBody == "" {
		t.Fatal("html body is empty")
	}
	if !utf8.ValidString(msg.TextBody) || !utf8.ValidString(msg.HTMLBody) {
		t.Fatal("body not valid utf-8")
	}
	if msg.Subject != "Automatic reply: Enquiry Category : 自僱人士服務 Ref ID : UMD0009385009252590" {
		t.Fatalf("unexpected subject: %q", msg.Subject)
	}
}

func buildBig5Message() []byte {
	var buf bytes.Buffer
	buf.WriteString("From: a@b.c\r\nTo: d@e.c\r\nSubject: =?Big5?B?" + base64.StdEncoding.EncodeToString(big5s("測試")) + "?=\r\n")
	buf.WriteString("Content-Type: multipart/alternative; boundary=\"BOUND\"\r\n\r\n")
	buf.WriteString("--BOUND\r\n")
	buf.WriteString("Content-Type: text/plain; charset=\"big5\"\r\nContent-Transfer-Encoding: base64\r\n\r\n")
	buf.WriteString(base64.StdEncoding.EncodeToString(big5s("你好")))
	buf.WriteString("\r\n")
	buf.WriteString("--BOUND\r\n")
	buf.WriteString("Content-Type: text/html; charset=\"big5\"\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n")
	buf.WriteString(quotedPrintable(big5s("你好")))
	buf.WriteString("\r\n--BOUND--\r\n")
	return buf.Bytes()
}
