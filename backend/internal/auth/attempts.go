package auth

import (
	"sync"
	"time"
)

// AttemptLimiter 滑動視窗失敗限流器（供 change-password 等敏感端點防舊密碼粗力度）
type AttemptLimiter struct {
	mu       sync.Mutex
	failures map[string][]time.Time
}

// NewAttemptLimiter 建立空限流器
func NewAttemptLimiter() *AttemptLimiter {
	return &AttemptLimiter{failures: make(map[string][]time.Time)}
}

// Blocked 回報 key 於 window 內嘅失敗次數係咪已達 maxFailures
func (l *AttemptLimiter) Blocked(key string, maxFailures int, window time.Duration) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.recent(key, window)) >= maxFailures
}

// RecordFailure 為 key 追加一次失敗時間戳
func (l *AttemptLimiter) RecordFailure(key string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.failures[key] = append(l.recent(key, time.Hour), time.Now())
}

// Reset 清除 key 嘅失敗記錄（成功後呼叫）
func (l *AttemptLimiter) Reset(key string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.failures, key)
}

// recent 取 window 內嘅失敗（呼叫者需持有鎖）；順帶清理過期記錄
func (l *AttemptLimiter) recent(key string, window time.Duration) []time.Time {
	list := l.failures[key]
	if len(list) == 0 {
		return nil
	}
	cutoff := time.Now().Add(-window)
	kept := list[:0]
	for _, t := range list {
		if t.After(cutoff) {
			kept = append(kept, t)
		}
	}
	if len(kept) == 0 {
		delete(l.failures, key)
		return nil
	}
	l.failures[key] = kept
	return kept
}
