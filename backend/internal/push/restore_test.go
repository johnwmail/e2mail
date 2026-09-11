package push

import (
	"testing"
	"time"

	"github.com/johnwmail/e2mail/backend/internal/imap"
	"github.com/johnwmail/e2mail/backend/internal/session"
	"github.com/johnwmail/e2mail/backend/internal/storage"
)

func TestRestoreDeviceSessionsSameSecret(t *testing.T) {
	key := make([]byte, 32)
	copy(key, []byte("0123456789abcdef0123456789abcdef"))
	ms, err := session.NewMemoryStore(time.Hour, key)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ms.Close() })
	dek := make([]byte, 32)
	copy(dek, []byte("dekdekdekdekdekdekdekdekdekdekde"))
	sess, err := ms.Create(&session.Session{Email: "a@b.c", Username: "a"}, dek)
	if err != nil {
		t.Fatal(err)
	}

	db, err := storage.NewSQLiteStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	if err := db.UpsertDeviceSession(storage.DeviceSession{
		SessionID:    sess.ID,
		OwnerEmail:   sess.Email,
		EncDEK:       sess.EncryptedDEK,
		LastActiveAt: time.Now().UTC(),
		CreatedAt:    time.Now().UTC(),
	}, dek); err != nil {
		t.Fatal(err)
	}

	ms2, err := session.NewMemoryStore(time.Hour, key)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ms2.Close() })
	n := RestoreDeviceSessions(ms2, db, imap.NewIdleManager(), 24*time.Hour)
	if n != 1 {
		t.Fatalf("restored %d, want 1", n)
	}
	got, err := ms2.Get(sess.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Email != "a@b.c" {
		t.Fatalf("email %q", got.Email)
	}
	out, err := ms2.GetDecryptedDEK(got)
	if err != nil {
		t.Fatal(err)
	}
	if string(out) != string(dek) {
		t.Fatal("dek mismatch after restore")
	}
}
