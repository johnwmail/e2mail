package api

import (
	"io/fs"
	"net/http"
	"path"
	"strings"

	"github.com/johnwmail/e2mail/backend/web"
)

const frontendCSP = "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'self'; form-action 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self'; frame-src 'self'"

// staticHandler 服務 embedded frontend（SPA）。
// 任何未由 /api 或其他 route 處理的請求都會 fallback 到 index.html；
// /api 未匹配的請求則返回 404。
func staticHandler() http.HandlerFunc {
	sub, err := fs.Sub(web.Files, "dist")
	if err != nil {
		return func(w http.ResponseWriter, r *http.Request) { http.NotFound(w, r) }
	}
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Security-Policy", frontendCSP)
		if strings.HasPrefix(r.URL.Path, "/api/") {
			http.NotFound(w, r)
			return
		}
		p := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
		if p == "." || p == "" {
			p = "index.html"
		}
		if _, err := sub.Open(p); err != nil {
			p = "index.html"
		}
		http.ServeFileFS(w, r, sub, p)
	}
}