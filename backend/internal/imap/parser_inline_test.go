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

func TestParseRFC822AppleMailInlineImageWithoutContentID(t *testing.T) {
	// iPhone Mail 寄「只有相片」嘅郵件：空白 text/plain + Content-Disposition: inline
	// 圖片，冇 Content-ID、冇 HTML body。圖片必須保留，前端才可以在內文顯示。
	raw := strings.Join([]string{
		"From: sender@example.com",
		"To: rcpt@example.com",
		"Subject: photo",
		"MIME-Version: 1.0",
		`Content-Type: multipart/mixed; boundary="Apple-Mail-1"`,
		"",
		"--Apple-Mail-1",
		"Content-Type: text/plain; charset=us-ascii",
		"Content-Transfer-Encoding: 7bit",
		"",
		"",
		"",
		"--Apple-Mail-1",
		"Content-Type: image/jpeg;",
		"\tname=photo.JPG;",
		"\tx-apple-part-url=48AC3048-44A7-454A-8A25-436535F53660",
		"Content-Disposition: inline;",
		"\tfilename=photo.JPG",
		"Content-Transfer-Encoding: base64",
		"",
		"/9j/4AAQSkZJRg==",
		"--Apple-Mail-1--",
		"",
	}, "\r\n")

	msg, err := ParseRFC822Message([]byte(raw), 1, nil)
	if err != nil {
		t.Fatalf("ParseRFC822Message: %v", err)
	}
	if msg.HTMLBody != "" {
		t.Errorf("htmlBody = %q, want empty", msg.HTMLBody)
	}
	if len(msg.Attachments) != 1 {
		t.Fatalf("attachments = %d, want 1", len(msg.Attachments))
	}
	att := msg.Attachments[0]
	if att.Filename != "photo.JPG" || att.ContentType != "image/jpeg" {
		t.Errorf("filename/contentType = %q/%q", att.Filename, att.ContentType)
	}
	if att.ContentID != "" {
		t.Errorf("contentId = %q, want empty (Apple Mail omits Content-ID)", att.ContentID)
	}
	if !att.IsInline || len(att.Data) == 0 {
		t.Errorf("inline/data = %v/%d", att.IsInline, len(att.Data))
	}
	if !strings.HasPrefix(att.InlineData, "data:image/jpeg;base64,") {
		t.Errorf("inlineData = %q, want jpeg data URL", att.InlineData)
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
