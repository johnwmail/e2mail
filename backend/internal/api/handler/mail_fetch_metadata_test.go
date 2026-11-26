package handler

import (
	"net/http/httptest"
	"testing"
)

func TestIsSameOriginFetch(t *testing.T) {
	cases := map[string]bool{
		"":            true,  // 舊瀏覽器冇 Fetch Metadata：維持原行為（SameSite=Lax 仍然生效）
		"same-origin": true,  // SPA 自身 fetch
		"none":        true,  // 用戶直接輸入網址
		"same-site":   false, // 同站但唔同 origin（例如兄弟子網域）不可改狀態
		"cross-site":  false, // 第三方網站誘導導航
	}
	for site, want := range cases {
		req := httptest.NewRequest("GET", "/api/mail/messages/1", nil)
		if site != "" {
			req.Header.Set("Sec-Fetch-Site", site)
		}
		if got := isSameOriginFetch(req); got != want {
			t.Errorf("Sec-Fetch-Site=%q: got %v, want %v", site, got, want)
		}
	}
}
