package middleware

import (
	"net/http"
	"strings"

	"github.com/johnwmail/e2mail/backend/pkg/response"
)

const (
	defaultRequestBodyLimit int64 = 1 << 20  // 1 MiB for ordinary API requests
	importRequestBodyLimit  int64 = 5 << 20  // 5 MiB for contact imports
	mailRequestBodyLimit    int64 = 25 << 20 // 25 MiB including multipart overhead
)

// RequestBodyLimit bounds API request bodies. Content-Length requests that
// exceed the endpoint's limit are rejected before any handler work; unknown
// length bodies are protected by MaxBytesReader while handlers consume them.
func RequestBodyLimit(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		limit := requestBodyLimit(r)
		if r.ContentLength > limit {
			response.Error(w, http.StatusRequestEntityTooLarge, "request body too large")
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, limit)
		next.ServeHTTP(w, r)
	})
}

func requestBodyLimit(r *http.Request) int64 {
	path := r.URL.Path
	switch {
	case r.Method == http.MethodPost && (path == "/api/mail/send" || path == "/api/mail/drafts"):
		return mailRequestBodyLimit
	case r.Method == http.MethodPost && (path == "/api/contacts/import" ||
		path == "/api/pgp/contacts/import" ||
		path == "/api/pgp/contacts/bulk"):
		return importRequestBodyLimit
	case strings.HasSuffix(path, "/avatar") && r.Method == http.MethodPut:
		return 5 << 20
	default:
		return defaultRequestBodyLimit
	}
}
