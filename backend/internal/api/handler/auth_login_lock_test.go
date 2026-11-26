package handler

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
)

func loginReqFrom(remote string) *http.Request {
	r := httptest.NewRequest(http.MethodPost, "/api/auth/login", nil)
	r.RemoteAddr = remote
	return r
}

// 攻擊者由單一 IP 對受害者 email 連續失敗後，只鎖住該 (email, IP) 組合；
// 受害者由其他 IP 仍然可以登入（唔會被換 IP 攻擊鎖死）。
func TestLoginLockIsScopedToEmailAndIP(t *testing.T) {
	h := newTestAuthHandler(t)
	const victim = "victim@example.com"

	attacker := loginReqFrom("198.51.100.10:50000")
	for i := 0; i < loginMaxEmailIP; i++ {
		h.recordLoginFailure(attacker, victim)
	}

	if !h.loginBlocked(httptest.NewRecorder(), attacker, victim) {
		t.Fatal("attacker's (email, IP) pair should be blocked after repeated failures")
	}

	victimElsewhere := loginReqFrom("203.0.113.20:50000")
	if h.loginBlocked(httptest.NewRecorder(), victimElsewhere, victim) {
		t.Fatal("victim from a different IP must not be locked out by the attacker's IP")
	}
}

// 分散式攻擊（每次換 IP）會觸發全局 email 上限，之後任何 IP 都要等待。
func TestLoginLockGlobalEmailLimitAcrossIPs(t *testing.T) {
	h := newTestAuthHandler(t)
	const victim = "target@example.com"

	for i := 0; i < loginMaxEmail; i++ {
		h.recordLoginFailure(loginReqFrom(fmt.Sprintf("198.51.100.%d:50000", i+1)), victim)
	}

	rec := httptest.NewRecorder()
	if !h.loginBlocked(rec, loginReqFrom("192.0.2.200:50000"), victim) {
		t.Fatal("global email limit should block logins for the email from any IP")
	}
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want 429", rec.Code)
	}
}

// 成功登入會清除該 (email, IP) 與 email 計數。
func TestResetLoginFailuresClearsEmailIPAndEmailCounters(t *testing.T) {
	h := newTestAuthHandler(t)
	const email = "ok@example.com"
	r := loginReqFrom("198.51.100.77:50000")

	for i := 0; i < loginMaxEmailIP; i++ {
		h.recordLoginFailure(r, email)
	}
	h.resetLoginFailures(r, email)

	if h.loginBlocked(httptest.NewRecorder(), r, email) {
		t.Fatal("successful login should clear the (email, IP) lock")
	}
}
