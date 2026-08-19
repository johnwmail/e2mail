package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"

	"github.com/go-chi/chi/v5"
	"modern-webmail/backend/internal/api/middleware"
	"modern-webmail/backend/internal/session"
	"modern-webmail/backend/internal/storage"
)

func newTestContactsHandler(t *testing.T) *ContactsHandler {
	t.Helper()
	store, err := storage.NewSQLiteStore(t.TempDir())
	if err != nil {
		t.Fatalf("NewSQLiteStore: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	return NewContactsHandler(store)
}

func contactCtx(email string) context.Context {
	return context.WithValue(context.Background(), middleware.SessionContextKey, &session.Session{Email: email})
}

func TestDeleteContactURLEncodedEmail(t *testing.T) {
	h := newTestContactsHandler(t)
	ctx := contactCtx("owner@example.com")

	r := chi.NewRouter()
	r.Route("/pgp", func(pr chi.Router) {
		pr.Get("/contacts", h.ListContacts)
		pr.Post("/contacts", h.UpsertContact)
		pr.Delete("/contacts/{email}", h.DeleteContact)
	})

	// 1. Upsert（email 用混合大小寫，模擬真實輸入）
	var buf bytes.Buffer
	_ = json.NewEncoder(&buf).Encode(ContactKeyDTO{
		Email:            "Alice@Example.COM",
		Name:             "Alice",
		PublicKeyArmored: "-----BEGIN PGP PUBLIC KEY BLOCK-----abc",
		Fingerprint:      "ABCDEF",
	})
	req := httptest.NewRequest(http.MethodPost, "/pgp/contacts", &buf).WithContext(ctx)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("upsert status = %d, body %s", w.Code, w.Body.String())
	}

	// 2. Delete，模擬前端 removeContactKey：encodeURIComponent(email.toLowerCase())
	//    （encodeURIComponent 會將 '@' encode 成 %40，同 url.QueryEscape 一致）
	delURL := "/pgp/contacts/" + url.QueryEscape("alice@example.com")
	req2 := httptest.NewRequest(http.MethodDelete, delURL, nil).WithContext(ctx)
	w2 := httptest.NewRecorder()
	r.ServeHTTP(w2, req2)
	if w2.Code != http.StatusOK {
		t.Fatalf("delete status = %d, body %s", w2.Code, w2.Body.String())
	}

	// 3. List，應該冇晒
	req3 := httptest.NewRequest(http.MethodGet, "/pgp/contacts", nil).WithContext(ctx)
	w3 := httptest.NewRecorder()
	r.ServeHTTP(w3, req3)
	if w3.Code != http.StatusOK {
		t.Fatalf("list status = %d", w3.Code)
	}
	var resp struct {
		Success bool            `json:"success"`
		Data    json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(w3.Body.Bytes(), &resp); err != nil {
		t.Fatalf("list decode: %v", err)
	}
	var list []ContactKeyDTO
	if err := json.Unmarshal(resp.Data, &list); err != nil {
		t.Fatalf("list data decode: %v", err)
	}
	if len(list) != 0 {
		t.Fatalf("expected 0 contacts after delete, got %d: %+v", len(list), list)
	}
}
