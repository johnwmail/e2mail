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
// 已存在嘅 asset 直接回；其他請求只有在「似 SPA client route」時才 fallback 去
// index.html，否則回 404 —— 避免掃描器探測 /root/.ssh/key、/.env、/wp-login.php
// 等路徑時一律收到 200 index.html。
// /api 未匹配的請求返回 404。
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
		// 明確拒絕 path traversal（embed FS + Clean 本身已唔會洩漏，呢個係縱深防禦）
		if strings.Contains(r.URL.Path, "..") {
			http.NotFound(w, r)
			return
		}

		p := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
		if p == "" {
			http.ServeFileFS(w, r, sub, "index.html")
			return
		}

		// 真正存在嘅 embedded asset（/assets/*.js、favicon.ico、mail.svg …）
		if f, openErr := sub.Open(p); openErr == nil {
			_ = f.Close()
			http.ServeFileFS(w, r, sub, p)
			return
		}

		// SPA fallback：只限「似導覽」嘅請求（Accept: text/html）＋非檔案／非 dotfile 路徑
		if isSPARoute(p) && strings.Contains(r.Header.Get("Accept"), "text/html") {
			http.ServeFileFS(w, r, sub, "index.html")
			return
		}

		http.NotFound(w, r)
	}
}

// isSPARoute 判斷路徑係咪一個 client-side route（而唔係檔案／dotfile）。
//
//	"settings"、"mail/inbox"      -> true
//	".env"、".git/config"        -> false
//	"root/.ssh/key"               -> false（".ssh" 以點開頭）
//	"wp-login.php"、"x.key"       -> false（有副檔名）
func isSPARoute(p string) bool {
	for _, seg := range strings.Split(p, "/") {
		if seg == "" {
			continue
		}
		if strings.HasPrefix(seg, ".") {
			return false
		}
	}
	return !strings.Contains(path.Base(p), ".")
}
