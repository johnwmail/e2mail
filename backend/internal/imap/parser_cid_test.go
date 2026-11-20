package imap

import (
	"strings"
	"testing"
)

func TestParseRFC822CIDWithoutAngleBrackets(t *testing.T) {
	raw := strings.Join([]string{
		"From: sender@example.com",
		"To: rcpt@example.com",
		"Subject: cid test",
		"MIME-Version: 1.0",
		`Content-Type: multipart/mixed; boundary="b"`,
		"",
		"--b",
		"Content-Type: text/html; charset=utf-8",
		"Content-Disposition: inline",
		"",
		`<html><img src="cid:cc_hk_blank"><img src="cid:logo-CN_03"></html>`,
		"--b",
		"Content-Type: image/gif",
		"Content-Transfer-Encoding: base64",
		"Content-ID: cc_hk_blank",
		"Content-Disposition: inline",
		"",
		"R0lGODlhAQABAIAAAOvr6wAAACH5BAAAAAAALAAAAAABAAEAAAICRAEAOw==",
		"--b",
		"Content-Type: image/gif",
		"Content-Transfer-Encoding: base64",
		"Content-ID: logo-CN_03",
		"Content-Disposition: inline",
		"",
		"R0lGODlhAQABAIAAAOvr6wAAACH5BAAAAAAALAAAAAABAAEAAAICRAEAOw==-",
		"--b--",
		"",
	}, "\r\n")

	msg, err := ParseRFC822Message([]byte(raw), 1, nil)
	if err != nil {
		t.Fatalf("ParseRFC822Message: %v", err)
	}
	if len(msg.Attachments) != 2 {
		t.Fatalf("attachments = %d, want 2: %#v", len(msg.Attachments), msg.Attachments)
	}
	for _, a := range msg.Attachments {
		t.Logf("id=%s contentId=%q filename=%q inline=%v", a.ID, a.ContentID, a.Filename, a.IsInline)
	}
	if msg.Attachments[0].ContentID != "cc_hk_blank" || msg.Attachments[1].ContentID != "logo-CN_03" {
		t.Fatalf("content IDs not parsed: %#v", msg.Attachments)
	}
}
