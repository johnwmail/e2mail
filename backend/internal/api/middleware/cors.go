package middleware

import (
	"net/http"
	"net/url"
	"strings"

	"github.com/go-chi/cors"
)

// CORS 只允許同 Host 嘅 Origin（SPA 同 API 同 origin）。唔再反射 https://* + credentials。
func CORS() func(http.Handler) http.Handler {
	return cors.Handler(cors.Options{
		AllowOriginFunc: func(r *http.Request, origin string) bool {
			if origin == "" {
				return true
			}
			u, err := url.Parse(origin)
			if err != nil || u.Host == "" {
				return false
			}
			return strings.EqualFold(u.Host, r.Host)
		},
		AllowedMethods:   []string{"GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"},
		AllowedHeaders:   []string{"Accept", "Authorization", "Content-Type", "X-Session-ID", "Last-Event-ID"},
		ExposedHeaders:   []string{"Link", "Content-Disposition"},
		AllowCredentials: true,
		MaxAge:           300, // 5 分鐘 preflight 快取
	})
}

// SecurityHeaders 注入基礎 Web 安全標頭
func SecurityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "SAMEORIGIN")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()")
		// HSTS：瀏覽器只會喺 HTTPS 回應中採信，喺純 HTTP 會被忽略，故可以無條件設定。
		w.Header().Set("Strict-Transport-Security", "max-age=31536000")
		// API 回應含郵件、通訊錄、PGP keyring 等敏感資料，禁止瀏覽器或中間快取保存。
		if strings.HasPrefix(r.URL.Path, "/api/") {
			w.Header().Set("Cache-Control", "no-store")
		}
		next.ServeHTTP(w, r)
	})
}
