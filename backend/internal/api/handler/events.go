package handler

import (
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/johnwmail/e2mail/backend/internal/api/middleware"
	"github.com/johnwmail/e2mail/backend/internal/imap"
	"github.com/johnwmail/e2mail/backend/internal/session"
)

// EventsHandler 處理 SSE 即時連線
type EventsHandler struct {
	idleMgr *imap.IdleManager
}

// NewEventsHandler 初始化 EventsHandler
func NewEventsHandler(idleMgr *imap.IdleManager) *EventsHandler {
	return &EventsHandler{
		idleMgr: idleMgr,
	}
}

// SSE 即時推播端點（多帳號 multiplex：單一連線訂閱所有帳號）
func (h *EventsHandler) SSE(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}

	sess, ok := middleware.GetSessionFromContext(r.Context())
	if !ok || sess == nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	authCtx := middleware.GetAccountContext(r.Context())

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	// 建立每條 account 嘅 listener，並訂閱
	type subscription struct {
		ch    <-chan imap.MailboxEvent
		unsub func()
	}
	var subscriptions []subscription

	unsubscribeAll := func() {
		for _, s := range subscriptions {
			s.unsub()
		}
	}
	defer unsubscribeAll()

	// 為每個帳號建立訂閱（用已解密嘅密碼）
	for _, acc := range sess.Accounts {
		password := ""
		if authCtx != nil {
			password = authCtx.Passwords[acc.ID]
		}
		config := imap.ConnectionConfig{
			Host:             acc.IMAPHost,
			Port:             acc.IMAPPort,
			UseTLS:           acc.IMAPUseTLS,
			AllowInsecureTLS: acc.IMAPAllowInsecureTLS,
			Username:         acc.Username,
			Password:         password,
		}
		listener := h.idleMgr.GetOrStartListener(sess.ID, acc.ID, config, password)
		ch, unsub := listener.Subscribe()
		subscriptions = append(subscriptions, subscription{ch: ch, unsub: unsub})
	}

	// 發送連線成功初始事件
	initData, _ := json.Marshal(map[string]any{
		"type":       "CONNECTED",
		"sessionId":  sess.ID,
		"email":      sess.Email,
		"accounts":   accountIDs(sess),
		"listeners":  len(subscriptions),
		"timestamp":  time.Now(),
	})
	_, _ = fmt.Fprintf(w, "event: init\ndata: %s\n\n", string(initData))
	flusher.Flush()

	heartbeatTicker := time.NewTicker(15 * time.Second)
	defer heartbeatTicker.Stop()

	for {
		select {
		case <-r.Context().Done():
			return
		case <-heartbeatTicker.C:
			// 發送 SSE Heartbeat 保活
			_, _ = fmt.Fprintf(w, ": heartbeat\n\n")
			flusher.Flush()
		default:
			// 輪詢所有帳號嘅事件 channel
			received := false
			for _, s := range subscriptions {
				select {
				case evt, ok := <-s.ch:
					if !ok {
						continue
					}
					data, err := json.Marshal(evt)
					if err == nil {
						_, _ = fmt.Fprintf(w, "event: mailbox_event\ndata: %s\n\n", string(data))
						flusher.Flush()
						received = true
					}
				default:
				}
			}
			if received {
				continue
			}
			// 短暫 sleep 避免 busy loop
			time.Sleep(50 * time.Millisecond)
		}
	}
}

func accountIDs(sess *session.Session) []string {
	ids := make([]string, 0, len(sess.Accounts))
	for _, acc := range sess.Accounts {
		ids = append(ids, acc.ID)
	}
	return ids
}
