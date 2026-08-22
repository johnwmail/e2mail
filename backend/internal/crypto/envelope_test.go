package crypto

import (
	"strings"
	"testing"
)

func TestDeriveMasterKeyDeterministic(t *testing.T) {
	salt, err := GenerateSalt()
	if err != nil {
		t.Fatalf("GenerateSalt: %v", err)
	}
	key1 := DeriveMasterKey("password", salt)
	key2 := DeriveMasterKey("password", salt)
	if len(key1) != 32 {
		t.Fatalf("key length = %d, want 32", len(key1))
	}
	if string(key1) != string(key2) {
		t.Fatal("same password + salt must yield same key")
	}
}

func TestDeriveMasterKeyDifferentSalt(t *testing.T) {
	salt1, _ := GenerateSalt()
	salt2, _ := GenerateSalt()
	key1 := DeriveMasterKey("password", salt1)
	key2 := DeriveMasterKey("password", salt2)
	if string(key1) == string(key2) {
		t.Fatal("different salts must yield different keys")
	}
}

func TestEncryptDecryptRoundtrip(t *testing.T) {
	dek, err := GenerateDEK()
	if err != nil {
		t.Fatalf("GenerateDEK: %v", err)
	}
	plaintext := []byte("secret password")

	enc, err := Encrypt(dek, plaintext)
	if err != nil {
		t.Fatalf("Encrypt: %v", err)
	}
	if strings.Contains(enc, string(plaintext)) {
		t.Fatal("ciphertext must not contain plaintext")
	}

	dec, err := Decrypt(dek, enc)
	if err != nil {
		t.Fatalf("Decrypt: %v", err)
	}
	if string(dec) != string(plaintext) {
		t.Fatalf("decrypted = %q, want %q", dec, plaintext)
	}
}

func TestDecryptWrongKey(t *testing.T) {
	dek1, _ := GenerateDEK()
	dek2, _ := GenerateDEK()
	enc, _ := Encrypt(dek1, []byte("data"))
	if _, err := Decrypt(dek2, enc); err == nil {
		t.Fatal("expected decryption error with wrong key")
	}
}

func TestDecryptTampered(t *testing.T) {
	dek, _ := GenerateDEK()
	enc, _ := Encrypt(dek, []byte("data"))
	tampered := enc[:len(enc)-4] + "AAAA"
	if _, err := Decrypt(dek, tampered); err == nil {
		t.Fatal("expected decryption error for tampered ciphertext")
	}
}

func TestEncryptRejectsShortKey(t *testing.T) {
	if _, err := Encrypt([]byte("short"), []byte("data")); err == nil {
		t.Fatal("expected error for non-32-byte key")
	}
}
