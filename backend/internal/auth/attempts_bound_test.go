package auth

import (
	"fmt"
	"testing"
	"time"
)

// 大量不同 email 嘗試時，記錄嘅 key 數量必須有上限，防止記憶體無限增長。
func TestAttemptLimiterKeyCountIsBounded(t *testing.T) {
	l := NewAttemptLimiter()
	for i := 0; i < attemptMaxKeys+500; i++ {
		l.RecordFailure(fmt.Sprintf("login:email:user%d@example.com", i))
	}
	l.mu.Lock()
	n := len(l.failures)
	l.mu.Unlock()
	if n > attemptMaxKeys {
		t.Fatalf("tracked keys = %d, want <= %d", n, attemptMaxKeys)
	}
}

// 超出上限後，新 key 仍然會被記錄（唔會 fail-open）。
func TestAttemptLimiterStillTracksNewKeysAtCapacity(t *testing.T) {
	l := NewAttemptLimiter()
	for i := 0; i < attemptMaxKeys; i++ {
		l.RecordFailure(fmt.Sprintf("k%d", i))
	}
	const target = "login:email:victim@example.com"
	for i := 0; i < 3; i++ {
		l.RecordFailure(target)
	}
	if !l.Blocked(target, 3, time.Minute) {
		t.Fatal("new key must still accumulate failures when the limiter is full")
	}
}

// 過期記錄會被清理，唔會長期佔用容量。
func TestAttemptLimiterSweepsExpiredKeys(t *testing.T) {
	l := NewAttemptLimiter()
	l.mu.Lock()
	old := time.Now().Add(-2 * time.Hour)
	for i := 0; i < 100; i++ {
		l.failures[fmt.Sprintf("stale%d", i)] = []time.Time{old}
	}
	l.lastSweep = time.Time{} // 強制下一次 RecordFailure 觸發 sweep
	l.mu.Unlock()

	l.RecordFailure("fresh")

	l.mu.Lock()
	defer l.mu.Unlock()
	if len(l.failures) != 1 {
		t.Fatalf("expired keys not swept: %d keys remain", len(l.failures))
	}
}
