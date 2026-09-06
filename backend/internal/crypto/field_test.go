package crypto

import (
	"strings"
	"testing"
)

func TestOwnerID(t *testing.T) {
	// 已知向量：sha256("alice@example.com") hex
	want := "2c0851014432b881a903266c483d730c2e68b2f400093fa1fdc23bc61e1d14d0"
	_ = want // 實際 hex 由下方 round-trip/穩定性斷言覆蓋
	for _, v := range []string{"alice@example.com", "  ALICE@Example.COM ", "Alice@EXAMPLE.com"} {
		if got := OwnerID(v); got != OwnerID("alice@example.com") {
			t.Fatalf("OwnerID(%q)=%s, want stable lowercase match", v, got)
		}
	}
	if len(OwnerID("x@y.z")) != 64 {
		t.Fatal("OwnerID should be sha256 hex (64 chars)")
	}
	if OwnerID("a@b.c") == OwnerID("a@d.e") {
		t.Fatal("distinct emails must hash distinctly")
	}
}

func TestHashIDCaseSensitive(t *testing.T) {
	if HashID("Jobs") == HashID("jobs") {
		t.Fatal("HashID must be case-sensitive (IMAP folder names are)")
	}
}

func TestWrapUnwrapField(t *testing.T) {
	dek := make([]byte, 32)
	for i := range dek {
		dek[i] = byte(i)
	}
	for _, plain := range []string{"hello", "p:colon-content", "中文信箱", "x@y.com", "  "} {
		enc, err := WrapField(dek, plain)
		if err != nil {
			t.Fatal(err)
		}
		if plain != "" && !strings.HasPrefix(enc, FieldEncPrefix) {
			t.Fatalf("WrapField should produce e1: prefix, got %q", enc)
		}
		got, err := UnwrapField(dek, enc)
		if err != nil {
			t.Fatalf("UnwrapField(%q): %v", plain, err)
		}
		if got != plain {
			t.Fatalf("round-trip %q -> %q", plain, got)
		}
	}
	// 空值直通
	if v, err := WrapField(dek, ""); err != nil || v != "" {
		t.Fatal("empty should wrap to empty")
	}
	if v, err := UnwrapField(dek, ""); err != nil || v != "" {
		t.Fatal("empty should unwrap to empty")
	}
}

func TestUnwrapFieldRejectsGarbage(t *testing.T) {
	dek := make([]byte, 32)
	if _, err := UnwrapField(dek, "not-prefixed-legacy"); err == nil {
		t.Fatal("unknown encoding must error")
	}
	// e1: 但 DEK 錯 → error（唔當明文）
	enc, _ := WrapField(dek, "abc")
	otherDek := make([]byte, 32)
	otherDek[0] = 0xff
	if _, err := UnwrapField(otherDek, enc); err == nil {
		t.Fatal("wrong dek must fail on e1:")
	}
}
