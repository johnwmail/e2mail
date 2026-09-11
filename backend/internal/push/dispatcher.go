package push

import (
	"log"
	"strconv"
	"strings"

	"github.com/johnwmail/e2mail/backend/internal/imap"
	"github.com/johnwmail/e2mail/backend/internal/session"
	"github.com/johnwmail/e2mail/backend/internal/storage"
)

// Dispatcher 將 IMAP IDLE NEW_MESSAGE 轉成裝置推播。
type Dispatcher struct {
	DB       storage.Store
	Sessions session.Store
	Sender   Sender
}

func (d *Dispatcher) Handle(evt imap.MailboxEvent) {
	if d == nil || d.DB == nil || d.Sessions == nil || d.Sender == nil {
		return
	}
	if evt.Type != "NEW_MESSAGE" || evt.SessionID == "" {
		return
	}
	sess, err := d.Sessions.Get(evt.SessionID)
	if err != nil || sess == nil {
		return
	}
	dek, err := d.Sessions.GetDecryptedDEK(sess)
	if err != nil {
		return
	}
	_ = d.DB.TouchDeviceSession(sess.ID)

	enabled, _ := d.DB.GetUserPref(sess.Email, "pushEnabled", dek)
	if enabled == "false" {
		return
	}
	quietStart, _ := d.DB.GetUserPref(sess.Email, "pushQuietStart", dek)
	quietEnd, _ := d.DB.GetUserPref(sess.Email, "pushQuietEnd", dek)

	devices, err := d.DB.ListPushDevices(sess.Email, dek)
	if err != nil {
		log.Printf("[PUSH] list devices: %v", err)
		return
	}

	var msgs []Message
	for _, dev := range devices {
		if !accountAllowed(dev.AccountIDs, evt.AccountID) {
			continue
		}
		if InQuietHours(evt.Timestamp, loadLocation(dev.Timezone), quietStart, quietEnd) {
			continue
		}
		data := map[string]string{
			"type":      evt.Type,
			"accountId": evt.AccountID,
			"mailbox":   evt.Mailbox,
		}
		if evt.UID > 0 {
			data["uid"] = strconv.FormatUint(uint64(evt.UID), 10)
		}
		msgs = append(msgs, Message{
			To:               dev.Token,
			Title:            "e2Mail",
			Body:             "New message in " + displayMailbox(evt.Mailbox),
			Sound:            "default",
			ChannelID:        "mail",
			ContentAvailable: true,
			Data:             data,
			Badge:            int(evt.TotalCount),
		})
	}
	if err := d.Sender.Send(msgs); err != nil {
		log.Printf("[PUSH] send: %v", err)
	}
}

func accountAllowed(ids []string, accountID string) bool {
	if len(ids) == 0 || accountID == "" {
		return true
	}
	for _, id := range ids {
		if id == accountID {
			return true
		}
	}
	return false
}

func displayMailbox(name string) string {
	if strings.TrimSpace(name) == "" {
		return "Inbox"
	}
	return name
}
