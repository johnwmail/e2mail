package charsetutil

import (
	"io"
	"strings"
	"testing"
)

func TestDecodeHeaderUTF8(t *testing.T) {
	got := DecodeHeader("=?UTF-8?B?5L2g5aW9?=") // 你好
	if got != "你好" {
		t.Fatalf("got %q, want 你好", got)
	}
}

func TestDecodeHeaderBig5(t *testing.T) {
	// =?BIG5?B?pKSk5Q==?=  = 中文（Big5 編碼）
	got := DecodeHeader("=?BIG5?B?pKSk5Q==?=")
	if got != "中文" {
		t.Fatalf("got %q, want 中文", got)
	}
}

func TestDecodeHeaderPassthrough(t *testing.T) {
	if got := DecodeHeader("plain text"); got != "plain text" {
		t.Fatalf("got %q", got)
	}
	if got := DecodeHeader(""); got != "" {
		t.Fatalf("got %q", got)
	}
	// 無法解碼時回傳原始輸入
	in := "=?UNKNOWN?B?####?="
	if got := DecodeHeader(in); got != in {
		t.Fatalf("expected passthrough, got %q", got)
	}
}

func TestDecodeRFC2047Alias(t *testing.T) {
	if DecodeRFC2047("=?UTF-8?B?5L2g5aW9?=") != "你好" {
		t.Fatal("DecodeRFC2047 should match DecodeHeader")
	}
}

func TestGetEncodingCommon(t *testing.T) {
	names := []string{
		"", "utf-8", "UTF8", "utf-8", "us-ascii", "ascii",
		"big5", "big5-hkscs", "cp950", "windows-950",
		"gb2312", "gbk", "cp936", "gb18030",
		"euc-jp", "shift_jis", "sjis", "cp932",
		"windows-1252", "iso-8859-1",
	}
	for _, n := range names {
		if _, err := GetEncoding(n); err != nil {
			t.Errorf("GetEncoding(%q) unexpected error: %v", n, err)
		}
	}
}

func TestGetEncodingUnknown(t *testing.T) {
	if _, err := GetEncoding("totally-unknown-charset"); err == nil {
		t.Fatal("expected error for unknown charset")
	}
}

func TestToUTF8Big5(t *testing.T) {
	// Big5 編碼「中文」= 0xA4A4 0xA4E5
	data := []byte{0xa4, 0xa4, 0xa4, 0xe5}
	got, err := ToUTF8(data, "big5")
	if err != nil {
		t.Fatalf("ToUTF8: %v", err)
	}
	if got != "中文" {
		t.Fatalf("got %q, want 中文", got)
	}
}

func TestToUTF8AlreadyUTF8(t *testing.T) {
	s := "hello 中文"
	got, err := ToUTF8([]byte(s), "")
	if err != nil {
		t.Fatalf("ToUTF8: %v", err)
	}
	if got != s {
		t.Fatalf("got %q, want %q", got, s)
	}
}

func TestToUTF8Empty(t *testing.T) {
	got, err := ToUTF8(nil, "big5")
	if err != nil {
		t.Fatalf("ToUTF8: %v", err)
	}
	if got != "" {
		t.Fatalf("got %q, want empty", got)
	}
}

func TestNewReaderPassthrough(t *testing.T) {
	r, err := NewReader(strings.NewReader("hello"), "utf-8")
	if err != nil {
		t.Fatalf("NewReader: %v", err)
	}
	data, _ := io.ReadAll(r)
	if string(data) != "hello" {
		t.Fatalf("got %q", string(data))
	}
}

func TestNewReaderBig5(t *testing.T) {
	r, err := NewReader(strings.NewReader(string([]byte{0xa4, 0xa4, 0xa4, 0xe5})), "big5")
	if err != nil {
		t.Fatalf("NewReader: %v", err)
	}
	data, _ := io.ReadAll(r)
	if string(data) != "中文" {
		t.Fatalf("got %q, want 中文", string(data))
	}
}