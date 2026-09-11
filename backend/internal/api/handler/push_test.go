package handler

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/johnwmail/e2mail/backend/internal/api/middleware"
	"github.com/johnwmail/e2mail/backend/internal/imap"
	"github.com/johnwmail/e2mail/backend/internal/session"
	"github.com/johnwmail/e2mail/backend/internal/storage"
)

func TestPushRegisterListDelete(t *testing.T) {
	db, err := storage.NewSQLiteStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	ms, err := session.NewMemoryStore(time.Hour, make([]byte, 32))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ms.Close() })
	dek := make([]byte, 32)
	copy(dek, []byte("0123456789abcdef0123456789abcdef"))
	sess, err := ms.Create(&session.Session{Email: "owner@example.com"}, dek)
	if err != nil {
		t.Fatal(err)
	}

	h := NewPushHandler(db, ms, imap.NewIdleManager())
	r := chi.NewRouter()
	r.Group(func(pr chi.Router) {
		pr.Use(middleware.Auth(ms))
		pr.Get("/push/devices", h.List)
		pr.Post("/push/devices", h.Register)
		pr.Delete("/push/devices/{token:.*}", h.Unregister)
	})

	token := "ExponentPushToken[abc]"
	var buf bytes.Buffer
	_ = json.NewEncoder(&buf).Encode(registerPushRequest{
		Token: token, Platform: "ios", Timezone: "Asia/Hong_Kong", AccountIDs: []string{"acc"},
	})
	req := httptest.NewRequest(http.MethodPost, "/push/devices", &buf)
	req.Header.Set("Authorization", "Bearer "+sess.ID)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("register %d %s", w.Code, w.Body.String())
	}

	req2 := httptest.NewRequest(http.MethodGet, "/push/devices", nil)
	req2.Header.Set("Authorization", "Bearer "+sess.ID)
	w2 := httptest.NewRecorder()
	r.ServeHTTP(w2, req2)
	if w2.Code != http.StatusOK {
		t.Fatalf("list %d %s", w2.Code, w2.Body.String())
	}

	del := httptest.NewRequest(http.MethodDelete, "/push/devices/"+url.PathEscape(token), nil)
	del.Header.Set("Authorization", "Bearer "+sess.ID)
	w3 := httptest.NewRecorder()
	r.ServeHTTP(w3, del)
	if w3.Code != http.StatusOK {
		t.Fatalf("delete %d %s", w3.Code, w3.Body.String())
	}
}
