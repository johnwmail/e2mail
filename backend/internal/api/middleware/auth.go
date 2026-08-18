package middleware

import (
	"context"
	"net/http"
	"strings"

	"modern-webmail/backend/internal/session"
	"modern-webmail/backend/pkg/response"
)

type contextKey string

const (
	SessionContextKey  contextKey = "session"
	PasswordContextKey contextKey = "password"
)

// Auth 驗證會話中間件
func Auth(store session.Store) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			token := extractToken(r)
			if token == "" {
				response.Unauthorized(w, "missing or invalid authorization token")
				return
			}

			sess, err := store.Get(token)
			if err != nil {
				response.Unauthorized(w, "session expired or invalid")
				return
			}

			password, err := store.GetDecryptedPassword(sess)
			if err != nil {
				response.Unauthorized(w, "failed to decrypt session credentials")
				return
			}

			_ = store.Touch(sess.ID)

			ctx := context.WithValue(r.Context(), SessionContextKey, sess)
			ctx = context.WithValue(ctx, PasswordContextKey, password)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// extractToken 優先從 Header、Cookie 與 Query 提取 Token
func extractToken(r *http.Request) string {
	// 1. Authorization: Bearer <token>
	authHeader := r.Header.Get("Authorization")
	if strings.HasPrefix(authHeader, "Bearer ") {
		return strings.TrimSpace(strings.TrimPrefix(authHeader, "Bearer "))
	}

	// 2. X-Session-ID Header
	if xSession := r.Header.Get("X-Session-ID"); xSession != "" {
		return strings.TrimSpace(xSession)
	}

	// 3. Cookie
	if cookie, err := r.Cookie("webmail_session"); err == nil && cookie.Value != "" {
		return strings.TrimSpace(cookie.Value)
	}

	// 4. Query string (用於 SSE 或 附件下載)
	if qToken := r.URL.Query().Get("token"); qToken != "" {
		return strings.TrimSpace(qToken)
	}

	return ""
}

// GetSessionFromContext 從 Request Context 取得目前會話
func GetSessionFromContext(ctx context.Context) (*session.Session, bool) {
	sess, ok := ctx.Value(SessionContextKey).(*session.Session)
	return sess, ok
}

// GetPasswordFromContext 從 Request Context 取得解密密碼
func GetPasswordFromContext(ctx context.Context) (string, bool) {
	pass, ok := ctx.Value(PasswordContextKey).(string)
	return pass, ok
}
