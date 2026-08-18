package auth

import (
	"testing"
	"time"
)

func TestPendingLoginStoreCRUD(t *testing.T) {
	ps := NewPendingLoginStore(10 * time.Minute)

	pl := &PendingLogin{Email: "a@b.c", FailedAttempts: 99}
	id := ps.Create(pl)
	if id == "" {
		t.Fatal("Create returned empty id")
	}

	got := ps.Get(id)
	if got == nil {
		t.Fatal("expected pending login to exist")
	}
	if got.Email != "a@b.c" {
		t.Fatalf("email = %q, want a@b.c", got.Email)
	}
	if got.FailedAttempts != 0 {
		t.Fatalf("Create should reset FailedAttempts, got %d", got.FailedAttempts)
	}
	if got.ExpiresAt.IsZero() {
		t.Fatal("ExpiresAt should be set")
	}

	ps.Delete(id)
	if ps.Get(id) != nil {
		t.Fatal("expected pending login to be gone after Delete")
	}
	if ps.Get("does-not-exist") != nil {
		t.Fatal("expected nil for unknown id")
	}
}

func TestPendingLoginExpiry(t *testing.T) {
	ps := NewPendingLoginStore(10 * time.Minute)
	id := ps.Create(&PendingLogin{})

	pl := ps.Get(id)
	pl.ExpiresAt = time.Now().Add(-time.Second)

	if ps.Get(id) != nil {
		t.Fatal("expired pending login should return nil")
	}
}

func TestPendingLoginMaxAttempts(t *testing.T) {
	ps := NewPendingLoginStore(10 * time.Minute)
	id := ps.Create(&PendingLogin{})

	for i := 0; i < 5; i++ {
		ps.MarkFailed(id)
	}
	if ps.Get(id) != nil {
		t.Fatal("pending login should be auto-deleted after max attempts")
	}
}

func TestPendingLoginSurvivesSomeFailures(t *testing.T) {
	ps := NewPendingLoginStore(10 * time.Minute)
	id := ps.Create(&PendingLogin{})

	ps.MarkFailed(id)
	ps.MarkFailed(id)

	got := ps.Get(id)
	if got == nil {
		t.Fatal("pending login should survive below the attempt limit")
	}
	if got.FailedAttempts != 2 {
		t.Fatalf("FailedAttempts = %d, want 2", got.FailedAttempts)
	}
}

func TestMarkFailedUnknownID(t *testing.T) {
	ps := NewPendingLoginStore(10 * time.Minute)
	ps.MarkFailed("unknown") // must not panic
}