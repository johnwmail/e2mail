package auth

import (
	"sync"
	"time"
)

const (
	// attemptMaxKeys 限制記錄嘅 key 數量。key 含有攻擊者可任意輸入嘅 email，
	// 冇上限會令記憶體無限增長。
	attemptMaxKeys = 10_000
	// attemptRetention 必須 >= 所有 Blocked 使用嘅 window（目前最長 1 小時）。
	attemptRetention = time.Hour
	attemptSweepGap  = time.Minute
)

// AttemptLimiter 滑動視窗失敗限流器（供 change-password 等敏感端點防舊密碼粗力度）
type AttemptLimiter struct {
	mu        sync.Mutex
	failures  map[string][]time.Time
	lastSweep time.Time
}

// NewAttemptLimiter 建立空限流器
func NewAttemptLimiter() *AttemptLimiter {
	return &AttemptLimiter{failures: make(map[string][]time.Time)}
}

// sweepLocked 清理所有 key 中已過期嘅失敗記錄（呼叫者需持有鎖）
func (l *AttemptLimiter) sweepLocked(now time.Time) {
	for key := range l.failures {
		_ = l.recent(key, attemptRetention)
	}
	l.lastSweep = now
}

// evictOldestLocked 當 key 數達上限時，移除最近一次失敗最舊嘅 key（呼叫者需持有鎖）
func (l *AttemptLimiter) evictOldestLocked() {
	var oldestKey string
	var oldest time.Time
	first := true
	for key, list := range l.failures {
		if len(list) == 0 {
			delete(l.failures, key)
			return
		}
		last := list[len(list)-1]
		if first || last.Before(oldest) {
			oldestKey, oldest, first = key, last, false
		}
	}
	if !first {
		delete(l.failures, oldestKey)
	}
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
	now := time.Now()
	if now.Sub(l.lastSweep) >= attemptSweepGap {
		l.sweepLocked(now)
	}
	if _, exists := l.failures[key]; !exists && len(l.failures) >= attemptMaxKeys {
		l.evictOldestLocked()
	}
	l.failures[key] = append(l.recent(key, attemptRetention), now)
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
