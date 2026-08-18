package imap

import (
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/emersion/go-imap/v2"
	"modern-webmail/backend/internal/session"
)

// MailboxEvent 定義即時推播事件
type MailboxEvent struct {
	Type        string    `json:"type"` // "NEW_MESSAGE", "EXPUNGE", "FLAG_UPDATE", "HEARTBEAT"
	Mailbox     string    `json:"mailbox"`
	TotalCount  uint32    `json:"totalCount,omitempty"`
	Timestamp   time.Time `json:"timestamp"`
}

// IdleListener 單一使用者的 IMAP IDLE 監聽協程
type IdleListener struct {
	sess         *session.Session
	password     string
	mailbox      string
	eventCh      chan MailboxEvent
	subscribers  map[chan MailboxEvent]struct{}
	subMu        sync.Mutex
	stopCh       chan struct{}
	closed       bool
}

// NewIdleListener 建立 IDLE 監聽器
func NewIdleListener(sess *session.Session, plainPassword, mailbox string) *IdleListener {
	if mailbox == "" {
		mailbox = "INBOX"
	}
	return &IdleListener{
		sess:        sess,
		password:    plainPassword,
		mailbox:     mailbox,
		eventCh:     make(chan MailboxEvent, 100),
		subscribers: make(map[chan MailboxEvent]struct{}),
		stopCh:      make(chan struct{}),
	}
}

// Subscribe 訂閱事件廣播
func (l *IdleListener) Subscribe() (<-chan MailboxEvent, func()) {
	ch := make(chan MailboxEvent, 20)
	l.subMu.Lock()
	l.subscribers[ch] = struct{}{}
	l.subMu.Unlock()

	unsubscribe := func() {
		l.subMu.Lock()
		delete(l.subscribers, ch)
		close(ch)
		l.subMu.Unlock()
	}

	return ch, unsubscribe
}

// Broadcast 廣播事件至所有訂閱者
func (l *IdleListener) Broadcast(event MailboxEvent) {
	l.subMu.Lock()
	defer l.subMu.Unlock()

	for ch := range l.subscribers {
		select {
		case ch <- event:
		default:
		}
	}
}

// Start 啟動 IDLE 監聽背景循環
func (l *IdleListener) Start() {
	go func() {
		for {
			select {
			case <-l.stopCh:
				return
			default:
				err := l.runIdleLoop()
				if err != nil {
					log.Printf("[IMAP IDLE] session %s error: %v, retrying in 10s...", l.sess.ID, err)
					time.Sleep(10 * time.Second)
				}
			}
		}
	}()
}

// runIdleLoop 執行單次 IDLE 連線週期
func (l *IdleListener) runIdleLoop() error {
	config := ConnectionConfig{
		Host:             l.sess.IMAPHost,
		Port:             l.sess.IMAPPort,
		UseTLS:           l.sess.IMAPUseTLS,
		AllowInsecureTLS: l.sess.IMAPAllowInsecureTLS,
		Username:         l.sess.Username,
		Password:         l.password,
	}

	client, err := NewClient(config)
	if err != nil {
		return err
	}
	defer func() { _ = client.Close() }()

	// 選取信箱
	selectData, err := client.rawClient.Select(l.mailbox, nil).Wait()
	if err != nil {
		return err
	}

	caps, _ := client.rawClient.Capability().Wait()
	hasIdle := caps.Has(imap.CapIdle)

	// 若伺服器不支援 IDLE，採用溫和輪詢（每 60 秒）
	if !hasIdle {
		ticker := time.NewTicker(60 * time.Second)
		defer ticker.Stop()

		var lastCount = selectData.NumMessages

		for {
			select {
			case <-l.stopCh:
				return nil
			case <-ticker.C:
				stat, statErr := client.rawClient.Status(l.mailbox, &imap.StatusOptions{NumMessages: true}).Wait()
				if statErr == nil && stat.NumMessages != nil && *stat.NumMessages != lastCount {
					lastCount = *stat.NumMessages
					l.Broadcast(MailboxEvent{
						Type:       "NEW_MESSAGE",
						Mailbox:    l.mailbox,
						TotalCount: lastCount,
						Timestamp:  time.Now(),
					})
				}
			}
		}
	}

	// 支援 IMAP IDLE
	// RFC 2177 建議每 28 分鐘重新發出 IDLE 避免逾時
	idleRefreshTicker := time.NewTicker(25 * time.Minute)
	defer idleRefreshTicker.Stop()

	idleCmd, err := client.rawClient.Idle()
	if err != nil {
		return fmt.Errorf("failed to start IDLE: %w", err)
	}

	for {
		select {
		case <-l.stopCh:
			_ = idleCmd.Close()
			return nil
		case <-idleRefreshTicker.C:
			_ = idleCmd.Close()
			return nil // 重新進入外層循環刷新連線
		}
	}
}

// Stop 停止監聽
func (l *IdleListener) Stop() {
	l.subMu.Lock()
	defer l.subMu.Unlock()
	if !l.closed {
		l.closed = true
		close(l.stopCh)
	}
}

// IdleManager 管理所有活躍會話的 IDLE 監聽器
type IdleManager struct {
	mu        sync.RWMutex
	listeners map[string]*IdleListener
}

// NewIdleManager 初始化管理器
func NewIdleManager() *IdleManager {
	return &IdleManager{
		listeners: make(map[string]*IdleListener),
	}
}

// GetOrStartListener 取得或建立監聽器
func (im *IdleManager) GetOrStartListener(sess *session.Session, plainPassword string) *IdleListener {
	im.mu.Lock()
	defer im.mu.Unlock()

	if l, exists := im.listeners[sess.ID]; exists {
		return l
	}

	listener := NewIdleListener(sess, plainPassword, "INBOX")
	listener.Start()
	im.listeners[sess.ID] = listener
	return listener
}

// StopListener 停止並移除監聽器
func (im *IdleManager) StopListener(sessionID string) {
	im.mu.Lock()
	defer im.mu.Unlock()

	if l, exists := im.listeners[sessionID]; exists {
		l.Stop()
		delete(im.listeners, sessionID)
	}
}
