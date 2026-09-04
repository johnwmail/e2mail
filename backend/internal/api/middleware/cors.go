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
		AllowedHeaders:   []string{"Accept", "Authorization", "Content-Type", "X-CSRF-Token", "X-Session-ID", "Last-Event-ID"},
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
		w.Header().Set("X-XSS-Protection", "1; mode=block")
		next.ServeHTTP(w, r)
	})
}
