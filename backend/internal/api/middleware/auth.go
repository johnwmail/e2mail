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
	// Passwords: accountID -> plaintext password 的請求內快取（IMAP 與 SMTP 共用同一密碼）。
	// 由 PasswordFor 按需填充；唔應假設已包含所有帳號。
	Passwords map[string]string
}

// PasswordFor 取得指定帳號嘅明文密碼。首次存取時以 DEK 解密並快取於 Passwords。
// 解密失敗或帳號不存在時回傳 ("", false)。
func (c *AuthContext) PasswordFor(accountID string) (string, bool) {
	if c == nil {
		return "", false
	}
	if p, ok := c.Passwords[accountID]; ok {
		return p, true
	}
	if c.Session == nil || len(c.DEK) == 0 {
		return "", false
	}
	for _, acc := range c.Session.Accounts {
		if acc.ID != accountID {
			continue
		}
		pass, err := crypto.Decrypt(c.DEK, acc.EncIMAPPassword)
		if err != nil {
			// 單一帳號密碼解唔到唔阻礙其他帳號，該帳號會變唔可用
			return "", false
		}
		if c.Passwords == nil {
			c.Passwords = make(map[string]string, len(c.Session.Accounts))
		}
		c.Passwords[accountID] = string(pass)
		return c.Passwords[accountID], true
	}
	return "", false
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

			_ = store.Touch(sess.ID)

			// 密碼唔再每個請求都全部解密：只喺真正需要 IMAP/SMTP 時按帳號解密（見 PasswordFor）。
			authCtx := &AuthContext{Session: sess, DEK: dek}
			ctx := context.WithValue(r.Context(), SessionContextKey, sess)
			ctx = context.WithValue(ctx, AuthContextKey, authCtx)
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
					return authCtx.PasswordFor(acc.ID)
				}
			}
			for _, acc := range authCtx.Session.Accounts {
				if p, ok := authCtx.PasswordFor(acc.ID); ok {
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
	pass, _ := authCtx.PasswordFor(acc.ID)
	return pass
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
