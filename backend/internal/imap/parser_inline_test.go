package imap

import (
	"strings"
	"testing"
)

func TestParseRFC822AttachmentIDsAreUnique(t *testing.T) {
	raw := strings.Join([]string{
		"From: sender@example.com",
		"To: rcpt@example.com",
		"Subject: mixed",
		"MIME-Version: 1.0",
		`Content-Type: multipart/mixed; boundary="b"`,
		"",
		"--b",
		"Content-Type: text/html; charset=utf-8",
		"",
		"<p>hi</p>",
		"--b",
		"Content-Type: image/gif",
		"Content-ID: <img>",
		"Content-Disposition: inline",
		"Content-Transfer-Encoding: base64",
		"",
		"R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==",
		"--b",
		"Content-Type: application/pdf",
		`Content-Disposition: attachment; filename="stmt.pdf"`,
		"Content-Transfer-Encoding: base64",
		"",
		"JVBERi0=",
		"--b--",
		"",
	}, "\r\n")

	msg, err := ParseRFC822Message([]byte(raw), 2, nil)
	if err != nil {
		t.Fatalf("ParseRFC822Message: %v", err)
	}
	if len(msg.Attachments) != 2 {
		t.Fatalf("attachments = %d, want 2", len(msg.Attachments))
	}
	if msg.Attachments[0].ID == msg.Attachments[1].ID {
		t.Fatalf("duplicate attachment IDs: %q / %q", msg.Attachments[0].ID, msg.Attachments[1].ID)
	}
	if msg.Attachments[0].ID != "1" || msg.Attachments[1].ID != "2" {
		t.Fatalf("IDs = %q, %q; want 1, 2", msg.Attachments[0].ID, msg.Attachments[1].ID)
	}
	if !msg.Attachments[0].IsInline || msg.Attachments[1].IsInline {
		t.Errorf("inline flags = %v / %v", msg.Attachments[0].IsInline, msg.Attachments[1].IsInline)
	}
}

func TestParseRFC822InlinePartsUseContentLocationAndDropEmptySpacers(t *testing.T) {
	raw := strings.Join([]string{
		"From: sender@example.com",
		"To: rcpt@example.com",
		"Subject: eStatement",
		"MIME-Version: 1.0",
		`Content-Type: multipart/related; boundary="b"`,
		"",
		"--b",
		"Content-Type: text/html; charset=utf-8",
		"",
		`<html><img src="cid:logo"></html>`,
		"--b",
		"Content-Type: image/gif",
		"Content-ID: <logo>",
		"Content-Disposition: inline",
		"Content-Location: logo-CN_03.gif",
		"Content-Transfer-Encoding: base64",
		"",
		"R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==",
		"--b",
		"Content-Type: image/gif",
		"Content-Disposition: inline",
		"Content-Transfer-Encoding: base64",
		"",
		"--b--",
		"",
	}, "\r\n")

	msg, err := ParseRFC822Message([]byte(raw), 1, nil)
	if err != nil {
		t.Fatalf("ParseRFC822Message: %v", err)
	}
	if !strings.Contains(msg.HTMLBody, "cid:logo") {
		t.Fatalf("HTML body not parsed: %q", msg.HTMLBody)
	}
	if len(msg.Attachments) != 1 {
		t.Fatalf("attachments = %d, want 1 (empty inline spacer must be dropped): %#v", len(msg.Attachments), msg.Attachments)
	}
	att := msg.Attachments[0]
	if att.Filename != "logo-CN_03.gif" {
		t.Errorf("filename = %q, want logo-CN_03.gif", att.Filename)
	}
	if att.ContentID != "logo" || !att.IsInline {
		t.Errorf("contentId/isInline = %q/%v", att.ContentID, att.IsInline)
	}
	if len(att.Data) == 0 {
		t.Error("inline image data must be retained for cid: rendering")
	}
}
