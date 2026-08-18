package auth

import (
	"sync"
	"time"

	"github.com/google/uuid"
)

// PendingLogin 暫存登入參數，等待使用者完成 2FA 驗證
type PendingLogin struct {
	Email                string
	Username             string
	Password             string
	IMAPHost             string
	IMAPPort             int
	IMAPUseTLS           bool
	IMAPAllowInsecureTLS bool
	SMTPHost             string
	SMTPPort             int
	SMTPUseTLS           bool
	SMTPAllowInsecureTLS bool
	ExpiresAt            time.Time
	FailedAttempts       int
}

// PendingLoginStore 記憶體中的 pending login 儲存（短暫 TTL）
type PendingLoginStore struct {
	mu          sync.Mutex
	pending     map[string]*PendingLogin
	ttl         time.Duration
	maxAttempts int
}

// NewPendingLoginStore 初始化 pending login store
func NewPendingLoginStore(ttl time.Duration) *PendingLoginStore {
	ps := &PendingLoginStore{
		pending:     make(map[string]*PendingLogin),
		ttl:         ttl,
		maxAttempts: 5,
	}
	go ps.startCleaner()
	return ps
}

// Create 建立一個新的 pending login challenge，回傳 challenge ID
func (ps *PendingLoginStore) Create(pl *PendingLogin) string {
	id := uuid.New().String()
	pl.ExpiresAt = time.Now().Add(ps.ttl)
	pl.FailedAttempts = 0
	ps.mu.Lock()
	ps.pending[id] = pl
	ps.mu.Unlock()
	return id
}

// Get 取得並驗證 pending login（不存在或過期回傳 nil）
func (ps *PendingLoginStore) Get(id string) *PendingLogin {
	ps.mu.Lock()
	defer ps.mu.Unlock()
	pl, ok := ps.pending[id]
	if !ok {
		return nil
	}
	if time.Now().After(pl.ExpiresAt) {
		delete(ps.pending, id)
		return nil
	}
	return pl
}

// MarkFailed 記錄一次驗證失敗；超過上限自動刪除
func (ps *PendingLoginStore) MarkFailed(id string) {
	ps.mu.Lock()
	defer ps.mu.Unlock()
	pl, ok := ps.pending[id]
	if !ok {
		return
	}
	pl.FailedAttempts++
	if pl.FailedAttempts >= ps.maxAttempts {
		delete(ps.pending, id)
	}
}

// Delete 刪除一個 pending login
func (ps *PendingLoginStore) Delete(id string) {
	ps.mu.Lock()
	delete(ps.pending, id)
	ps.mu.Unlock()
}

// startCleaner 定期清理過期的 pending login
func (ps *PendingLoginStore) startCleaner() {
	ticker := time.NewTicker(ps.ttl / 2)
	defer ticker.Stop()
	for range ticker.C {
		now := time.Now()
		ps.mu.Lock()
		for id, pl := range ps.pending {
			if now.After(pl.ExpiresAt) {
				delete(ps.pending, id)
			}
		}
		ps.mu.Unlock()
	}
}
