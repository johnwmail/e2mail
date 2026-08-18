package session

import (
	"testing"
	"time"
)

func newTestStore(t *testing.T) *MemoryStore {
	t.Helper()
	ms, err := NewMemoryStore(10*time.Minute, nil)
	if err != nil {
		t.Fatalf("NewMemoryStore: %v", err)
	}
	t.Cleanup(func() { _ = ms.Close() })
	return ms
}

func TestCreateGetAndDecrypt(t *testing.T) {
	ms := newTestStore(t)

	sess, err := ms.Create(&Session{Email: "a@b.c", Username: "a"}, "secret-pass")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if sess.ID == "" {
		t.Fatal("expected generated session id")
	}
	if sess.EncryptedPassword == "secret-pass" {
		t.Fatal("password must be encrypted at rest")
	}
	if sess.CreatedAt.IsZero() || sess.LastActiveAt.IsZero() {
		t.Fatal("timestamps should be set")
	}

	got, err := ms.Get(sess.ID)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got.Email != "a@b.c" {
		t.Fatalf("email = %q, want a@b.c", got.Email)
	}

	pass, err := ms.GetDecryptedPassword(got)
	if err != nil {
		t.Fatalf("GetDecryptedPassword: %v", err)
	}
	if pass != "secret-pass" {
		t.Fatalf("password = %q, want secret-pass", pass)
	}
}

func TestCreatePreservesProvidedID(t *testing.T) {
	ms := newTestStore(t)
	sess, err := ms.Create(&Session{ID: "fixed-id", Email: "a@b.c"}, "pw")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if sess.ID != "fixed-id" {
		t.Fatalf("id = %q, want fixed-id", sess.ID)
	}
	if _, err := ms.Get("fixed-id"); err != nil {
		t.Fatalf("Get: %v", err)
	}
}

func TestGetNotFound(t *testing.T) {
	ms := newTestStore(t)
	if _, err := ms.Get("missing"); err != ErrSessionNotFound {
		t.Fatalf("Get(missing) err = %v, want ErrSessionNotFound", err)
	}
}

func TestTouchNotFound(t *testing.T) {
	ms := newTestStore(t)
	if err := ms.Touch("missing"); err != ErrSessionNotFound {
		t.Fatalf("Touch(missing) err = %v, want ErrSessionNotFound", err)
	}
}

func TestTouchUpdatesLastActiveAt(t *testing.T) {
	ms := newTestStore(t)
	sess, _ := ms.Create(&Session{Email: "a@b.c"}, "pw")
	old := sess.LastActiveAt

	time.Sleep(2 * time.Millisecond)
	if err := ms.Touch(sess.ID); err != nil {
		t.Fatalf("Touch: %v", err)
	}

	fresh, _ := ms.Get(sess.ID)
	if !fresh.LastActiveAt.After(old) {
		t.Fatal("LastActiveAt should be updated by Touch")
	}
}

func TestExpiredSession(t *testing.T) {
	ms, err := NewMemoryStore(50*time.Millisecond, nil)
	if err != nil {
		t.Fatalf("NewMemoryStore: %v", err)
	}
	defer func() { _ = ms.Close() }()

	sess, _ := ms.Create(&Session{Email: "a@b.c"}, "pw")
	time.Sleep(80 * time.Millisecond)

	if _, err := ms.Get(sess.ID); err != ErrSessionExpired {
		t.Fatalf("Get expired err = %v, want ErrSessionExpired", err)
	}
}

func TestDelete(t *testing.T) {
	ms := newTestStore(t)
	sess, _ := ms.Create(&Session{Email: "a@b.c"}, "pw")
	if err := ms.Delete(sess.ID); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if _, err := ms.Get(sess.ID); err != ErrSessionNotFound {
		t.Fatalf("Get after Delete err = %v, want ErrSessionNotFound", err)
	}
}

func TestInvalidMasterKeyLength(t *testing.T) {
	if _, err := NewMemoryStore(time.Minute, []byte("too-short")); err == nil {
		t.Fatal("expected error for non-32-byte master key")
	}
}

func TestTamperedCiphertext(t *testing.T) {
	ms := newTestStore(t)
	sess, _ := ms.Create(&Session{Email: "a@b.c"}, "pw")

	sess.EncryptedPassword = sess.EncryptedPassword[:len(sess.EncryptedPassword)-4] + "AAAA"
	if _, err := ms.GetDecryptedPassword(sess); err == nil {
		t.Fatal("expected decryption error for tampered ciphertext")
	}
}