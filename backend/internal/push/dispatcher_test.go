package push

import (
	"testing"
	"time"

	"github.com/johnwmail/e2mail/backend/internal/imap"
	"github.com/johnwmail/e2mail/backend/internal/session"
	"github.com/johnwmail/e2mail/backend/internal/storage"
)

type captureSender struct {
	msgs []Message
}

func (c *captureSender) Send(messages []Message) error {
	c.msgs = append(c.msgs, messages...)
	return nil
}

func TestDispatcherSendsOnNewMessage(t *testing.T) {
	db, err := storage.NewSQLiteStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	ms, err := session.NewMemoryStore(time.Hour, make([]byte, 32))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ms.Close() })
	dek := make([]byte, 32)
	copy(dek, []byte("0123456789abcdef0123456789abcdef"))
	sess, err := ms.Create(&session.Session{Email: "a@b.c"}, dek)
	if err != nil {
		t.Fatal(err)
	}
	if err := db.UpsertPushDevice(storage.PushDevice{
		OwnerEmail: "a@b.c",
		SessionID:  sess.ID,
		Platform:   "ios",
		Token:      "ExponentPushToken[dev]",
		Timezone:   "UTC",
	}, dek); err != nil {
		t.Fatal(err)
	}

	cap := &captureSender{}
	d := &Dispatcher{DB: db, Sessions: ms, Sender: cap}
	d.Handle(imap.MailboxEvent{
		Type:       "NEW_MESSAGE",
		SessionID:  sess.ID,
		AccountID:  "acc",
		Mailbox:    "INBOX",
		TotalCount: 3,
		Timestamp:  time.Now().UTC(),
	})
	if len(cap.msgs) != 1 {
		t.Fatalf("got %d messages", len(cap.msgs))
	}
	if cap.msgs[0].Data["accountId"] != "acc" || cap.msgs[0].Data["mailbox"] != "INBOX" {
		t.Fatalf("data %+v", cap.msgs[0].Data)
	}

	cap.msgs = nil
	d.Handle(imap.MailboxEvent{Type: "FLAG_UPDATE", SessionID: sess.ID})
	if len(cap.msgs) != 0 {
		t.Fatal("non NEW_MESSAGE should not send")
	}
}

func TestDispatcherQuietHoursSuppress(t *testing.T) {
	db, err := storage.NewSQLiteStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	ms, err := session.NewMemoryStore(time.Hour, make([]byte, 32))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ms.Close() })
	dek := make([]byte, 32)
	copy(dek, []byte("0123456789abcdef0123456789abcdef"))
	sess, _ := ms.Create(&session.Session{Email: "a@b.c"}, dek)
	_ = db.UpsertPushDevice(storage.PushDevice{
		OwnerEmail: "a@b.c", SessionID: sess.ID, Platform: "ios",
		Token: "ExponentPushToken[dev]", Timezone: "UTC",
	}, dek)
	_ = db.SetUserPref("a@b.c", "pushQuietStart", "00:00", dek)
	_ = db.SetUserPref("a@b.c", "pushQuietEnd", "23:59", dek)

	cap := &captureSender{}
	d := &Dispatcher{DB: db, Sessions: ms, Sender: cap}
	d.Handle(imap.MailboxEvent{
		Type: "NEW_MESSAGE", SessionID: sess.ID, Mailbox: "INBOX", Timestamp: time.Now().UTC(),
	})
	if len(cap.msgs) != 0 {
		t.Fatal("quiet hours should suppress")
	}
}
