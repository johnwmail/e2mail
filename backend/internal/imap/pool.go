package imap

import (
	"context"
	"errors"
	"strings"
	"sync"
	"time"
)

var (
	ErrPoolClosed     = errors.New("connection pool is closed")
	ErrAcquireTimeout = errors.New("timeout acquiring IMAP connection")
)
// UserPool 單一使用者專屬的 IMAP 連線池
type UserPool struct {
	mu          sync.Mutex
	config      ConnectionConfig
	maxCapacity int
	idleTimeout time.Duration
	available   []*Client
	activeCount int
	closed      bool
	lastActive  time.Time
}

// NewUserPool 建立使用者連線池
func NewUserPool(config ConnectionConfig, maxCap int, idleTimeout time.Duration) *UserPool {
	if maxCap <= 0 {
		maxCap = 4
	}
	if idleTimeout <= 0 {
		idleTimeout = 5 * time.Minute
	}

	return &UserPool{
		config:      config,
		maxCapacity: maxCap,
		idleTimeout: idleTimeout,
		available:   make([]*Client, 0, maxCap),
		lastActive:  time.Now(),
	}
}

// Acquire 取得一條可用的 IMAP 連線
func (p *UserPool) Acquire(ctx context.Context) (*Client, error) {
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return nil, ErrPoolClosed
	}

	p.lastActive = time.Now()

	// 1. 優先重複使用空閒連線
	for len(p.available) > 0 {
		n := len(p.available) - 1
		client := p.available[n]
		p.available = p.available[:n]

		// 檢查連線是否過期或中斷
		if time.Since(client.lastUsed) < p.idleTimeout && client.rawClient != nil {
			p.mu.Unlock()
			return client, nil
		}

		// 連線已過期，主動關閉並減少 activeCount
		_ = client.Close()
		p.activeCount--
	}

	// 2. 若未達到上限，建立新連線
	if p.activeCount < p.maxCapacity {
		p.activeCount++
		p.mu.Unlock()

		newClient, err := NewClient(p.config)
		if err != nil {
			p.mu.Lock()
			p.activeCount--
			p.mu.Unlock()
			return nil, err
		}
		return newClient, nil
	}

	p.mu.Unlock()

	// 3. 超過上限則輪詢等待可用連線（最多等待 10 秒）
	timeout := time.After(10 * time.Second)
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-timeout:
			return nil, ErrAcquireTimeout
		case <-ticker.C:
			p.mu.Lock()
			if p.closed {
				p.mu.Unlock()
				return nil, ErrPoolClosed
			}
			if len(p.available) > 0 {
				n := len(p.available) - 1
				client := p.available[n]
				p.available = p.available[:n]
				// 驗證連線有效性（與 Acquire 快捷路徑一致）
				if client.rawClient == nil || time.Since(client.lastUsed) >= p.idleTimeout {
					_ = client.Close()
					p.activeCount--
					p.mu.Unlock()
					continue
				}
				p.mu.Unlock()
				return client, nil
			}
			p.mu.Unlock()
		}
	}
}

// Release 歸還連線至連線池
func (p *UserPool) Release(c *Client) {
	if c == nil {
		return
	}

	p.mu.Lock()
	defer p.mu.Unlock()

	if p.closed {
		_ = c.Close()
		p.activeCount--
		return
	}

	c.lastUsed = time.Now()
	p.lastActive = time.Now()
	p.available = append(p.available, c)
}

// Close 關閉連線池中所有連線
func (p *UserPool) Close() {
	p.mu.Lock()
	defer p.mu.Unlock()

	if p.closed {
		return
	}
	p.closed = true

	for _, c := range p.available {
		_ = c.Close()
	}
	p.available = nil
	p.activeCount = 0
}

// PoolManager 全域連線池管理器
type PoolManager struct {
	mu    sync.RWMutex
	pools map[string]*UserPool
}

// NewPoolManager 初始化全域連線池管理器
func NewPoolManager() *PoolManager {
	pm := &PoolManager{
		pools: make(map[string]*UserPool),
	}
	go pm.startJanitor(2 * time.Minute)
	return pm
}

// poolKey 以 session + account 為鍵，令同一 session 內每個帳號有獨立連線池
type poolKey struct {
	sessionID string
	accountID string
}

func (k poolKey) string() string {
	return k.sessionID + "::" + k.accountID
}

// GetClient 快捷取得連線與釋放函式（按 session + account 隔離）
func (pm *PoolManager) GetClient(ctx context.Context, sessionID, accountID string, config ConnectionConfig) (*Client, func(), error) {
	key := poolKey{sessionID: sessionID, accountID: accountID}

	pm.mu.Lock()
	pool, exists := pm.pools[key.string()]
	if !exists {
		pool = NewUserPool(config, 4, 5*time.Minute)
		pm.pools[key.string()] = pool
	}
	pm.mu.Unlock()

	client, err := pool.Acquire(ctx)
	if err != nil {
		return nil, nil, err
	}

	release := func() {
		pool.Release(client)
	}

	return client, release, nil
}

// DestroyPool 銷毀指定會話 + 帳號的連線池
func (pm *PoolManager) DestroyPool(sessionID, accountID string) {
	key := poolKey{sessionID: sessionID, accountID: accountID}

	pm.mu.Lock()
	defer pm.mu.Unlock()

	if pool, exists := pm.pools[key.string()]; exists {
		pool.Close()
		delete(pm.pools, key.string())
	}
}

// DestroySessionPools 銷毀指定會話的所有帳號連線池
func (pm *PoolManager) DestroySessionPools(sessionID string) {
	prefix := sessionID + "::"
	pm.mu.Lock()
	defer pm.mu.Unlock()

	for k, p := range pm.pools {
		if strings.HasPrefix(k, prefix) {
			p.Close()
			delete(pm.pools, k)
		}
	}
}

// CloseAll 關閉所有連線池
func (pm *PoolManager) CloseAll() {
	pm.mu.Lock()
	defer pm.mu.Unlock()

	for id, p := range pm.pools {
		p.Close()
		delete(pm.pools, id)
	}
}

// startJanitor 定期巡檢並清理長時間閒置的連線
func (pm *PoolManager) startJanitor(interval time.Duration) {
	ticker := time.NewTicker(interval)
	for range ticker.C {
		pm.mu.Lock()
		now := time.Now()
		for id, p := range pm.pools {
			p.mu.Lock()
			if now.Sub(p.lastActive) > 15*time.Minute {
				p.closed = true
				for _, c := range p.available {
					_ = c.Close()
				}
				p.available = nil
				p.activeCount = 0
				delete(pm.pools, id)
			}
			p.mu.Unlock()
		}
		pm.mu.Unlock()
	}
}
