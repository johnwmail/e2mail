package imap

import (
	"sync/atomic"
	"testing"
	"time"
)

func TestBroadcastInvokesHook(t *testing.T) {
	var n atomic.Int32
	l := NewIdleListener("sid", "acc", ConnectionConfig{}, "", "INBOX")
	l.onEvent = func(evt MailboxEvent) {
		if evt.SessionID != "sid" || evt.AccountID != "acc" || evt.Type != "NEW_MESSAGE" {
			t.Errorf("unexpected event %+v", evt)
		}
		n.Add(1)
	}
	l.Broadcast(MailboxEvent{Type: "NEW_MESSAGE", Mailbox: "INBOX", Timestamp: time.Now()})
	deadline := time.Now().Add(time.Second)
	for n.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if n.Load() != 1 {
		t.Fatalf("hook calls = %d", n.Load())
	}
}
