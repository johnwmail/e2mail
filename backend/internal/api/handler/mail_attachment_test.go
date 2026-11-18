package handler

import (
	"mime"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestWriteAttachmentInlineSafeImage(t *testing.T) {
	rec := httptest.NewRecorder()
	writeAttachment(rec, "image/png; charset=binary", "logo.png", []byte("png"), true)

	if got := rec.Header().Get("Content-Type"); got != "image/png" {
		t.Errorf("Content-Type = %q, want image/png", got)
	}
	disposition, params, err := mime.ParseMediaType(rec.Header().Get("Content-Disposition"))
	if err != nil {
		t.Fatalf("parse Content-Disposition: %v", err)
	}
	if disposition != "inline" {
		t.Errorf("disposition = %q, want inline", disposition)
	}
	if params["filename"] != "logo.png" {
		t.Errorf("filename = %q, want logo.png", params["filename"])
	}
	if got := rec.Header().Get("X-Content-Type-Options"); got != "nosniff" {
		t.Errorf("X-Content-Type-Options = %q, want nosniff", got)
	}
	if csp := rec.Header().Get("Content-Security-Policy"); !strings.Contains(csp, "sandbox") {
		t.Errorf("CSP = %q, want sandbox", csp)
	}
	if got := rec.Header().Get("Cross-Origin-Resource-Policy"); got != "same-origin" {
		t.Errorf("Cross-Origin-Resource-Policy = %q", got)
	}
}

func TestWriteAttachmentForcesDownloadForActiveContent(t *testing.T) {
	cases := []struct {
		contentType string
		wantType    string
	}{
		{"text/html; charset=utf-8", "text/html"},
		{"image/svg+xml", "image/svg+xml"},
		{"application/xhtml+xml", "application/xhtml+xml"},
		{"application/pdf", "application/pdf"},
		{"application/javascript", "application/javascript"},
		{"", "application/octet-stream"},
		{"not a media type;", "application/octet-stream"},
	}

	for _, tc := range cases {
		t.Run(tc.contentType, func(t *testing.T) {
			rec := httptest.NewRecorder()
			writeAttachment(rec, tc.contentType, "evil", []byte("<script>"), true)

			if got := rec.Header().Get("Content-Type"); got != tc.wantType {
				t.Errorf("Content-Type = %q, want %q", got, tc.wantType)
			}
			disposition, _, err := mime.ParseMediaType(rec.Header().Get("Content-Disposition"))
			if err != nil {
				t.Fatalf("parse Content-Disposition: %v", err)
			}
			if disposition != "attachment" {
				t.Errorf("disposition = %q, want attachment", disposition)
			}
		})
	}
}

func TestWriteAttachmentKeepsNonInlineImagesAsDownload(t *testing.T) {
	rec := httptest.NewRecorder()
	writeAttachment(rec, "image/png", "photo.png", []byte("png"), false)

	disposition, _, err := mime.ParseMediaType(rec.Header().Get("Content-Disposition"))
	if err != nil {
		t.Fatalf("parse Content-Disposition: %v", err)
	}
	if disposition != "attachment" {
		t.Errorf("disposition = %q, want attachment", disposition)
	}
}

func TestWriteAttachmentSanitisesFilenameHeader(t *testing.T) {
	rec := httptest.NewRecorder()
	writeAttachment(rec, "text/plain", "a\r\nX-Injected: 1\".txt", []byte("x"), false)

	header := rec.Header().Get("Content-Disposition")
	if strings.ContainsAny(header, "\r\n") {
		t.Fatalf("Content-Disposition contains CR/LF: %q", header)
	}
	if strings.Contains(header, "X-Injected") && strings.Contains(header, "\n") {
		t.Fatalf("header injection possible: %q", header)
	}
	if _, _, err := mime.ParseMediaType(header); err != nil {
		t.Fatalf("Content-Disposition is not parseable: %q: %v", header, err)
	}
}
