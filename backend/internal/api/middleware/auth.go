package middleware

import (
	"context"
	"net/http"
	"strings"

	"github.com/johnwmail/e2mail/backend/internal/crypto"
	"github.com/johnwmail/e2mail/backend/internal/session"
	"github.com/johnwmail/e2mail/backend/internal/storage"
	"github.com/johnwmail/e2mail/backend/pkg/response"
)

type contextKey string

const (
	SessionContextKey contextKey = "session"
	AccountContextKey contextKey = "account"
	AuthContextKey    contextKey = "authContext"
	// PasswordContextKey 保留用於向後相容；多帳號下建議改用 AccountContextKey
	PasswordContextKey contextKey = "password"
)

// AuthContext 存放已解鎖會話資料（session + DEK + per-account 密碼）
type AuthContext struct {
	Session *session.Session
	DEK     []byte
	// Passwords: accountID -> plaintext password（IMAP 與 SMTP 共用同一密碼）
	Passwords map[string]string
}

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

			dek, err := store.GetDecryptedDEK(sess)
			if err != nil {
				response.Unauthorized(w, "failed to decrypt session credentials")
				return
			}

			passwords := make(map[string]string, len(sess.Accounts))
			for _, acc := range sess.Accounts {
				pass, err := crypto.Decrypt(dek, acc.EncIMAPPassword)
				if err != nil {
					// 單一帳號密碼解唔到唔阻礙登入，但該帳號會變唔可用
					continue
				}
				passwords[acc.ID] = string(pass)
			}

			_ = store.Touch(sess.ID)

			authCtx := &AuthContext{Session: sess, DEK: dek, Passwords: passwords}
			ctx := context.WithValue(r.Context(), SessionContextKey, sess)
			ctx = context.WithValue(ctx, AuthContextKey, authCtx)
			// 向後相容：預設帳號密碼放返 PasswordContextKey
			var defaultPass string
			for _, acc := range sess.Accounts {
				if acc.IsDefault {
					defaultPass = passwords[acc.ID]
					break
				}
			}
			ctx = context.WithValue(ctx, PasswordContextKey, defaultPass)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// GetAccountContext 取得已解鎖會話資料
func GetAccountContext(ctx context.Context) *AuthContext {
	c, _ := ctx.Value(AuthContextKey).(*AuthContext)
	return c
}

// GetSessionFromContext 從 Request Context 取得目前會話
func GetSessionFromContext(ctx context.Context) (*session.Session, bool) {
	sess, ok := ctx.Value(SessionContextKey).(*session.Session)
	return sess, ok
}

// GetPasswordFromContext 從 Request Context 取得解密密碼（預設帳號）
func GetPasswordFromContext(ctx context.Context) (string, bool) {
	if authCtx := GetAccountContext(ctx); authCtx != nil {
		// 取預設帳號密碼
		if authCtx.Session != nil {
			for _, acc := range authCtx.Session.Accounts {
				if acc.IsDefault {
					return authCtx.Passwords[acc.ID], true
				}
			}
			if len(authCtx.Passwords) > 0 {
				for _, p := range authCtx.Passwords {
					return p, true
				}
			}
		}
	}
	pass, ok := ctx.Value(PasswordContextKey).(string)
	return pass, ok
}

// GetCurrentAccount 根據請求揀選目前帳號（缺省用 default）
func GetCurrentAccount(ctx context.Context, r *http.Request) (*AuthContext, *storage.Account) {
	authCtx := GetAccountContext(ctx)
	if authCtx == nil || authCtx.Session == nil {
		return nil, nil
	}

	accountID := resolveAccountID(r, authCtx.Session)
	var selected *storage.Account
	for i := range authCtx.Session.Accounts {
		if authCtx.Session.Accounts[i].ID == accountID {
			selected = &authCtx.Session.Accounts[i]
			break
		}
	}
	if selected == nil && len(authCtx.Session.Accounts) > 0 {
		// fallback 到 default
		for i := range authCtx.Session.Accounts {
			if authCtx.Session.Accounts[i].IsDefault {
				selected = &authCtx.Session.Accounts[i]
				break
			}
		}
	}
	if selected == nil {
		return authCtx, nil
	}
	return authCtx, selected
}

// GetCurrentAccountPassword 取得目前帳號嘅明文密碼
func GetCurrentAccountPassword(authCtx *AuthContext, acc *storage.Account) string {
	if authCtx == nil || acc == nil {
		return ""
	}
	return authCtx.Passwords[acc.ID]
}

// extractToken 由 Authorization、X-Session-ID 或 HttpOnly cookie 提取會話
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

	// 3. Cookie（SSE／附件下載用；唔再接受 ?token= 以免入 Referer／proxy log）
	if cookie, err := r.Cookie("e2Mail_session"); err == nil && cookie.Value != "" {
		return strings.TrimSpace(cookie.Value)
	}

	return ""
}

// resolveAccountID 從 query param 或 header 解析 account id
func resolveAccountID(r *http.Request, sess *session.Session) string {
	if rid := r.URL.Query().Get("account"); rid != "" {
		return rid
	}
	if hid := r.Header.Get("X-Account"); hid != "" {
		return hid
	}
	// 缺省 default
	if sess != nil {
		for _, acc := range sess.Accounts {
			if acc.IsDefault {
				return acc.ID
			}
		}
		if len(sess.Accounts) > 0 {
			return sess.Accounts[0].ID
		}
	}
	return ""
}
