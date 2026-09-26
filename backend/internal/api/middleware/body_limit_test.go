package middleware

import (
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestRequestBodyLimitRejectsOversizedContentLength(t *testing.T) {
	called := false
	h := RequestBodyLimit(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		called = true
	}))
	req := httptest.NewRequest(http.MethodPost, "/api/auth/login", strings.NewReader(strings.Repeat("x", int(defaultRequestBodyLimit+1))))
	rec := httptest.NewRecorder()

	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusRequestEntityTooLarge)
	}
	if called {
		t.Fatal("handler called for oversized request")
	}
}

func TestRequestBodyLimitBoundsUnknownLengthBody(t *testing.T) {
	h := RequestBodyLimit(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, err := io.ReadAll(r.Body); err != nil {
			var maxErr *http.MaxBytesError
			if !errors.As(err, &maxErr) {
				t.Errorf("body read error = %v, want MaxBytesError", err)
			}
			w.WriteHeader(http.StatusRequestEntityTooLarge)
			return
		}
		t.Error("expected body read to exceed limit")
	}))
	req := httptest.NewRequest(http.MethodPost, "/api/auth/login", strings.NewReader(strings.Repeat("x", int(defaultRequestBodyLimit+1))))
	req.ContentLength = -1
	rec := httptest.NewRecorder()

	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusRequestEntityTooLarge)
	}
}

func TestRequestBodyLimitEndpointClasses(t *testing.T) {
	cases := []struct {
		method string
		path   string
		want   int64
	}{
		{http.MethodPost, "/api/auth/login", defaultRequestBodyLimit},
		{http.MethodPost, "/api/contacts/import", importRequestBodyLimit},
		{http.MethodPost, "/api/pgp/contacts/bulk", importRequestBodyLimit},
		{http.MethodPost, "/api/mail/send", mailRequestBodyLimit},
		{http.MethodPost, "/api/mail/drafts", mailRequestBodyLimit},
		{http.MethodPut, "/api/contacts/123/avatar", 5 << 20},
		{http.MethodGet, "/api/mail/send", defaultRequestBodyLimit},
	}
	for _, tc := range cases {
		r := httptest.NewRequest(tc.method, tc.path, nil)
		if got := requestBodyLimit(r); got != tc.want {
			t.Errorf("requestBodyLimit(%s %s) = %d, want %d", tc.method, tc.path, got, tc.want)
		}
	}
}
