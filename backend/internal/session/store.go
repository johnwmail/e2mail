package session

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/johnwmail/e2mail/backend/internal/storage"
)

var (
	ErrSessionNotFound = errors.New("session not found")
	ErrSessionExpired  = errors.New("session expired")
)

// Session 儲存使用者於記憶體中的會話。密碼一律加密存 DB（見 storage.Account），
// Session 只保留解鎖後嘅 DEK，用嚟解密每個帳號嘅 IMAP/SMTP 密碼。
type Session struct {
	ID            string             `json:"id"`
	Email         string             `json:"email"`    // 登入者（owner user_email）
	Username      string             `json:"username"` // 首帳號認證使用者名稱
	Accounts      []storage.Account  `json:"accounts"` // 帳號設定（密碼欄位 json:"-"）
	EncryptedDEK  string             `json:"-"`        // AES-GCM(serverKey, DEK)，不對外序列化
	CreatedAt     time.Time          `json:"createdAt"`
	LastActiveAt  time.Time          `json:"lastActiveAt"`
}

// Store 會話管理介面
type Store interface {
	Create(sess *Session, dek []byte) (*Session, error)
	Get(id string) (*Session, error)
	GetDecryptedDEK(sess *Session) ([]byte, error)
	Touch(id string) error
	Delete(id string) error
	Close() error
}

// MemoryStore 基於記憶體並發安全的 Session Store 實作
type MemoryStore struct {
	mu         sync.RWMutex
	sessions   map[string]*Session
	ttl        time.Duration
	cipherGCM  cipher.AEAD
	stopTicker chan struct{}
}

// NewMemoryStore 初始化記憶體 Session Store，若 masterKey 為空則自動隨機產生 32 bytes Key
func NewMemoryStore(ttl time.Duration, masterKey []byte) (*MemoryStore, error) {
	if len(masterKey) == 0 {
		masterKey = make([]byte, 32)
		if _, err := io.ReadFull(rand.Reader, masterKey); err != nil {
			return nil, fmt.Errorf("failed to generate random encryption key: %w", err)
		}
	} else if len(masterKey) != 32 {
		return nil, errors.New("masterKey must be exactly 32 bytes for AES-256")
	}

	block, err := aes.NewCipher(masterKey)
	if err != nil {
		return nil, fmt.Errorf("failed to create AES cipher: %w", err)
	}

	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("failed to create GCM: %w", err)
	}

	ms := &MemoryStore{
		sessions:   make(map[string]*Session),
		ttl:        ttl,
		cipherGCM:  gcm,
		stopTicker: make(chan struct{}),
	}

	go ms.startCleaner(ttl / 2)
	return ms, nil
}

// encrypt 使用 AES-256-GCM 加密敏感資料（用 server key）
func (ms *MemoryStore) encrypt(plaintext []byte) (string, error) {
	nonce := make([]byte, ms.cipherGCM.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return "", err
	}
	ciphertext := ms.cipherGCM.Seal(nonce, nonce, plaintext, nil)
	return base64.StdEncoding.EncodeToString(ciphertext), nil
}

// decrypt 使用 AES-256-GCM 解密資料
func (ms *MemoryStore) decrypt(encryptedBase64 string) ([]byte, error) {
	data, err := base64.StdEncoding.DecodeString(encryptedBase64)
	if err != nil {
		return nil, err
	}
	nonceSize := ms.cipherGCM.NonceSize()
	if len(data) < nonceSize {
		return nil, errors.New("ciphertext too short")
	}
	nonce, ciphertext := data[:nonceSize], data[nonceSize:]
	plaintext, err := ms.cipherGCM.Open(nil, nonce, ciphertext, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to decrypt DEK: %w", err)
	}
	return plaintext, nil
}

// Create 建立並加密儲存新會話（DEK 加密後存記憶體）
func (ms *MemoryStore) Create(sess *Session, dek []byte) (*Session, error) {
	if len(dek) == 0 {
		return nil, errors.New("dek cannot be empty")
	}
	encDEK, err := ms.encrypt(dek)
	if err != nil {
		return nil, fmt.Errorf("failed to encrypt session DEK: %w", err)
	}

	if sess.ID == "" {
		sess.ID = uuid.New().String()
	}
	now := time.Now()
	sess.EncryptedDEK = encDEK
	sess.CreatedAt = now
	sess.LastActiveAt = now

	ms.mu.Lock()
	ms.sessions[sess.ID] = sess
	ms.mu.Unlock()

	return sess, nil
}

// Get 取得 Session 並驗證是否過期
func (ms *MemoryStore) Get(id string) (*Session, error) {
	ms.mu.RLock()
	sess, exists := ms.sessions[id]
	ms.mu.RUnlock()

	if !exists {
		return nil, ErrSessionNotFound
	}

	if time.Since(sess.LastActiveAt) > ms.ttl {
		_ = ms.Delete(id)
		return nil, ErrSessionExpired
	}

	return sess, nil
}

// GetDecryptedDEK 取得解密後的 DEK
func (ms *MemoryStore) GetDecryptedDEK(sess *Session) ([]byte, error) {
	return ms.decrypt(sess.EncryptedDEK)
}

// Touch 更新會話活躍時間
func (ms *MemoryStore) Touch(id string) error {
	ms.mu.Lock()
	defer ms.mu.Unlock()

	sess, exists := ms.sessions[id]
	if !exists {
		return ErrSessionNotFound
	}
	sess.LastActiveAt = time.Now()
	return nil
}

// Delete 移除指定 Session
func (ms *MemoryStore) Delete(id string) error {
	ms.mu.Lock()
	delete(ms.sessions, id)
	ms.mu.Unlock()
	return nil
}

// startCleaner 定期清理過期的 Session
func (ms *MemoryStore) startCleaner(interval time.Duration) {
	if interval < time.Minute {
		interval = time.Minute
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			ms.mu.Lock()
			now := time.Now()
			for id, sess := range ms.sessions {
				if now.Sub(sess.LastActiveAt) > ms.ttl {
					delete(ms.sessions, id)
				}
			}
			ms.mu.Unlock()
		case <-ms.stopTicker:
			return
		}
	}
}

// Close 關閉清理協程
func (ms *MemoryStore) Close() error {
	close(ms.stopTicker)
	return nil
}
