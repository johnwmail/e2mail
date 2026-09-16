package auth

import (
	"bytes"
	"testing"
	"time"

	"github.com/go-webauthn/webauthn/webauthn"
)

func TestCeremonyStorePutPeekTake(t *testing.T) {
	cs := newCeremonyStore(time.Minute)
	id := cs.Put(&webauthn.SessionData{Challenge: "abc"}, "pending-1")

	if p, ok := cs.PeekPayload(id); !ok || p != "pending-1" {
		t.Fatalf("PeekPayload = (%q, %v), want (pending-1, true)", p, ok)
	}
	// Peek 唔消耗
	if _, ok := cs.PeekPayload(id); !ok {
		t.Fatal("second PeekPayload should still succeed")
	}

	data, payload, ok := cs.Take(id)
	if !ok || data == nil || data.Challenge != "abc" || payload != "pending-1" {
		t.Fatalf("Take = (%+v, %q, %v)", data, payload, ok)
	}
	// 單次使用
	if _, _, ok := cs.Take(id); ok {
		t.Fatal("second Take should fail (single use)")
	}
	if _, ok := cs.PeekPayload(id); ok {
		t.Fatal("PeekPayload after Take should fail")
	}
}

func TestCeremonyStoreExpired(t *testing.T) {
	cs := newCeremonyStore(time.Minute)
	id := cs.Put(&webauthn.SessionData{Challenge: "x", Expires: time.Now().Add(-time.Second)}, "")
	if _, ok := cs.PeekPayload(id); ok {
		t.Fatal("expired ceremony must not peek")
	}
	if _, _, ok := cs.Take(id); ok {
		t.Fatal("expired ceremony must not take")
	}
}

func TestMarshalParseCredential(t *testing.T) {
	c := &webauthn.Credential{
		ID:        []byte{1, 2, 3},
		PublicKey: []byte{4, 5, 6},
		Authenticator: webauthn.Authenticator{
			SignCount: 5,
		},
	}
	raw, err := MarshalCredential(c)
	if err != nil {
		t.Fatalf("MarshalCredential: %v", err)
	}
	if raw == "" {
		t.Fatal("empty credential JSON")
	}
	got, err := ParseCredential(raw)
	if err != nil {
		t.Fatalf("ParseCredential: %v", err)
	}
	if !bytes.Equal(got.ID, c.ID) || !bytes.Equal(got.PublicKey, c.PublicKey) || got.Authenticator.SignCount != 5 {
		t.Fatalf("round-trip mismatch: %+v", got)
	}
}

func TestMarshalCredentialNil(t *testing.T) {
	if _, err := MarshalCredential(nil); err == nil {
		t.Fatal("expected error for nil credential")
	}
}

func TestParseCredentialInvalid(t *testing.T) {
	if _, err := ParseCredential("{not json"); err == nil {
		t.Fatal("expected error for invalid JSON")
	}
}

func TestNewWebAuthnServiceValidation(t *testing.T) {
	if _, err := NewWebAuthnService("example.com", "e2Mail", nil); err == nil {
		t.Fatal("expected error when no origins")
	}
	if _, err := NewWebAuthnService("example.com", "e2Mail", []string{"https://example.com"}); err != nil {
		t.Fatalf("valid config: %v", err)
	}
}

func TestNewWebAuthnUserStableID(t *testing.T) {
	u1 := NewWebAuthnUser("User@Example.com", nil)
	u2 := NewWebAuthnUser("user@example.com", nil)
	if !bytes.Equal(u1.WebAuthnID(), u2.WebAuthnID()) {
		t.Fatal("user id must be case-insensitive / stable")
	}
	if u1.WebAuthnName() != "User@Example.com" {
		t.Fatalf("name = %q", u1.WebAuthnName())
	}
	if len(u1.WebAuthnCredentials()) != 0 {
		t.Fatal("expected no credentials")
	}
}
