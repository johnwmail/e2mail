package handler

import (
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"modern-webmail/backend/internal/api/middleware"
	"modern-webmail/backend/internal/imap"
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

// SSE 即時推播端點
func (h *EventsHandler) SSE(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}

	sess, ok := middleware.GetSessionFromContext(r.Context())
	password, _ := middleware.GetPasswordFromContext(r.Context())
	if !ok || sess == nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	listener := h.idleMgr.GetOrStartListener(sess, password)
	eventCh, unsubscribe := listener.Subscribe()
	defer unsubscribe()

	// 發送連線成功初始事件
	initData, _ := json.Marshal(map[string]any{
		"type":      "CONNECTED",
		"sessionId": sess.ID,
		"email":     sess.Email,
		"timestamp": time.Now(),
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
		case evt, ok := <-eventCh:
			if !ok {
				return
			}
			data, err := json.Marshal(evt)
			if err == nil {
				_, _ = fmt.Fprintf(w, "event: mailbox_event\ndata: %s\n\n", string(data))
				flusher.Flush()
			}
		}
	}
}
