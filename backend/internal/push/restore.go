package push

import (
	"log"
	"time"

	"github.com/johnwmail/e2mail/backend/internal/crypto"
	"github.com/johnwmail/e2mail/backend/internal/imap"
	"github.com/johnwmail/e2mail/backend/internal/session"
	"github.com/johnwmail/e2mail/backend/internal/storage"
)

// StartIdleForSession 為會話內每個有密碼嘅帳號開 IMAP IDLE（唔依賴 SSE）。
func StartIdleForSession(idleMgr *imap.IdleManager, sess *session.Session, dek []byte) {
	if idleMgr == nil || sess == nil || len(dek) == 0 {
		return
	}
	for _, acc := range sess.Accounts {
		pass, err := crypto.Decrypt(dek, acc.EncIMAPPassword)
		if err != nil || len(pass) == 0 {
			continue
		}
		cfg := imap.ConnectionConfig{
			Host:             acc.IMAPHost,
			Port:             acc.IMAPPort,
			UseTLS:           acc.IMAPUseTLS,
			AllowInsecureTLS: acc.IMAPAllowInsecureTLS,
			Username:         acc.Username,
			Password:         string(pass),
		}
		idleMgr.GetOrStartListener(sess.ID, acc.ID, cfg, string(pass))
	}
}

// RestoreDeviceSessions 重啟後載入未過期嘅裝置會話並恢復 IDLE。
func RestoreDeviceSessions(sessStore session.Store, db storage.Store, idleMgr *imap.IdleManager, ttl time.Duration) int {
	if sessStore == nil || db == nil {
		return 0
	}
	rows, err := db.ListDeviceSessions()
	if err != nil {
		log.Printf("[PUSH] list device sessions: %v", err)
		return 0
	}
	restored := 0
	now := time.Now()
	for _, row := range rows {
		if ttl > 0 && !row.LastActiveAt.IsZero() && now.Sub(row.LastActiveAt) > ttl {
			_ = db.DeleteDeviceSession(row.SessionID)
			_ = db.DeletePushDevicesBySession(row.SessionID)
			continue
		}
		probe := &session.Session{EncryptedDEK: row.EncDEK}
		dek, err := sessStore.GetDecryptedDEK(probe)
		if err != nil {
			log.Printf("[PUSH] skip session %s: cannot unwrap DEK (is SESSION_SECRET stable?): %v", row.SessionID, err)
			continue
		}
		email, err := crypto.UnwrapField(dek, row.OwnerEmail)
		if err != nil || email == "" {
			log.Printf("[PUSH] skip session %s: unwrap owner email: %v", row.SessionID, err)
			continue
		}
		accounts, err := db.ListAccounts(email, dek)
		if err != nil {
			log.Printf("[PUSH] skip session %s: list accounts: %v", row.SessionID, err)
			continue
		}
		username := ""
		for _, a := range accounts {
			if a.IsDefault {
				username = a.Username
				break
			}
		}
		if username == "" && len(accounts) > 0 {
			username = accounts[0].Username
		}
		sess := &session.Session{
			ID:           row.SessionID,
			Email:        email,
			Username:     username,
			Accounts:     accounts,
			EncryptedDEK: row.EncDEK,
			CreatedAt:    row.CreatedAt,
			LastActiveAt: row.LastActiveAt,
		}
		if err := sessStore.Restore(sess); err != nil {
			log.Printf("[PUSH] restore session %s: %v", row.SessionID, err)
			continue
		}
		StartIdleForSession(idleMgr, sess, dek)
		restored++
	}
	return restored
}
