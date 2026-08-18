package storage

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

// ContactKey 儲存於 SQLite 之聯絡人公鑰
type ContactKey struct {
	OwnerEmail   string
	ContactEmail string
	Name         string
	Fingerprint  string
	KeyID        string
	ArmoredKey   string
	CreatedAt    time.Time
}

// Keyring 儲存於 SQLite 之個人 PGP 金鑰包（私鑰為 Passphrase 加密之密文）
// 統一以 ASCII-armored 字串儲存；前端若上傳 binary GPG 會先轉為 armored 再存入
type Keyring struct {
	Email                      string    `json:"email"`
	PublicKeyArmored           string    `json:"publicKeyArmored"`
	EncryptedPrivateKeyArmored string    `json:"encryptedPrivateKeyArmored"`
	Fingerprint                string    `json:"fingerprint"`
	KeyID                      string    `json:"keyId"`
	UpdatedAt                  time.Time `json:"updatedAt"`
}

// TwoFA 儲存於 SQLite 之兩步驟驗證設定（備份碼以 SHA-256 hash 儲存）
type TwoFA struct {
	OwnerEmail   string
	Secret       string
	BackupHashes []string
	EnabledAt    time.Time
}

// Store SQLite 儲存介面
type Store interface {
	// Contacts
	ListContacts(ownerEmail string) ([]ContactKey, error)
	GetContact(ownerEmail, contactEmail string) (*ContactKey, error)
	UpsertContact(contact ContactKey) error
	BulkUpsertContacts(ownerEmail string, contacts []ContactKey) (saved int, skipped []string, err error)
	DeleteContact(ownerEmail, contactEmail string) error

	// Personal keyring
	GetKeyring(ownerEmail string) (*Keyring, error)
	SaveKeyring(keyring *Keyring) error
	DeleteKeyring(ownerEmail string) error

	// Two-factor authentication
	GetTwoFA(ownerEmail string) (*TwoFA, error)
	SaveTwoFA(t *TwoFA) error
	DeleteTwoFA(ownerEmail string) error

	// Lifecycle
	MigrateLegacyKeyrings(dataDir string) (migrated int, err error)
	Close() error
}

const schema = `
CREATE TABLE IF NOT EXISTS contact_keys (
	owner_email    TEXT NOT NULL,
	contact_email  TEXT NOT NULL,
	name           TEXT NOT NULL DEFAULT '',
	fingerprint    TEXT NOT NULL,
	key_id         TEXT NOT NULL DEFAULT '',
	armored_key    TEXT NOT NULL,
	created_at     INTEGER NOT NULL,
	PRIMARY KEY (owner_email, contact_email)
);
CREATE INDEX IF NOT EXISTS idx_contact_keys_owner ON contact_keys(owner_email);

CREATE TABLE IF NOT EXISTS personal_keyrings (
	owner_email              TEXT NOT NULL PRIMARY KEY,
	public_key_armored       TEXT NOT NULL,
	encrypted_private_key    TEXT NOT NULL,
	fingerprint              TEXT NOT NULL,
	key_id                   TEXT NOT NULL DEFAULT '',
	updated_at               INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS two_fa (
	owner_email        TEXT NOT NULL PRIMARY KEY,
	secret             TEXT NOT NULL,
	backup_code_hashes TEXT NOT NULL DEFAULT '[]',
	enabled_at         INTEGER NOT NULL
);
`

// SQLiteStore SQLite 儲存實作
type SQLiteStore struct {
	db *sql.DB
	mu sync.Mutex
}

// NewSQLiteStore 於 dataDir/webmail.db 建立並初始化 SQLite 儲存
func NewSQLiteStore(dataDir string) (*SQLiteStore, error) {
	if err := os.MkdirAll(dataDir, 0700); err != nil {
		return nil, fmt.Errorf("failed to create storage dir: %w", err)
	}
	dbPath := filepath.Join(dataDir, "webmail.db")
	dsn := fmt.Sprintf("file:%s?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)&_pragma=foreign_keys(ON)", dbPath)
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("failed to open sqlite: %w", err)
	}
	db.SetMaxOpenConns(1) // SQLite 寫入序列化
	if err := db.Ping(); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("failed to ping sqlite: %w", err)
	}
	if _, err := db.Exec(schema); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("failed to apply schema: %w", err)
	}
	return &SQLiteStore{db: db}, nil
}

func (s *SQLiteStore) Close() error {
	return s.db.Close()
}

// ListContacts 取得某使用者所有聯絡人公鑰（依 contact_email 排序）
func (s *SQLiteStore) ListContacts(ownerEmail string) ([]ContactKey, error) {
	rows, err := s.db.Query(
		`SELECT contact_email, name, fingerprint, key_id, armored_key, created_at
		 FROM contact_keys WHERE owner_email = ? ORDER BY contact_email ASC`,
		ownerEmail,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to query contacts: %w", err)
	}
	defer rows.Close()

	out := make([]ContactKey, 0)
	for rows.Next() {
		var c ContactKey
		var createdAt int64
		if err := rows.Scan(&c.ContactEmail, &c.Name, &c.Fingerprint, &c.KeyID, &c.ArmoredKey, &createdAt); err != nil {
			return nil, fmt.Errorf("failed to scan contact: %w", err)
		}
		c.OwnerEmail = ownerEmail
		c.CreatedAt = time.Unix(createdAt, 0).UTC()
		out = append(out, c)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

// GetContact 取得單一聯絡人公鑰
func (s *SQLiteStore) GetContact(ownerEmail, contactEmail string) (*ContactKey, error) {
	var c ContactKey
	var createdAt int64
	err := s.db.QueryRow(
		`SELECT contact_email, name, fingerprint, key_id, armored_key, created_at
		 FROM contact_keys WHERE owner_email = ? AND contact_email = ?`,
		ownerEmail, contactEmail,
	).Scan(&c.ContactEmail, &c.Name, &c.Fingerprint, &c.KeyID, &c.ArmoredKey, &createdAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("failed to get contact: %w", err)
	}
	c.OwnerEmail = ownerEmail
	c.CreatedAt = time.Unix(createdAt, 0).UTC()
	return &c, nil
}

// UpsertContact 插入或更新單一聯絡人公鑰（覆蓋既有同名 contact）
func (s *SQLiteStore) UpsertContact(c ContactKey) error {
	if c.OwnerEmail == "" || c.ContactEmail == "" {
		return errors.New("owner_email and contact_email are required")
	}
	if c.ArmoredKey == "" || c.Fingerprint == "" {
		return errors.New("armored_key and fingerprint are required")
	}
	if c.CreatedAt.IsZero() {
		c.CreatedAt = time.Now().UTC()
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.Exec(
		`INSERT INTO contact_keys (owner_email, contact_email, name, fingerprint, key_id, armored_key, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(owner_email, contact_email) DO UPDATE SET
			name = excluded.name,
			fingerprint = excluded.fingerprint,
			key_id = excluded.key_id,
			armored_key = excluded.armored_key`,
		c.OwnerEmail, c.ContactEmail, c.Name, c.Fingerprint, c.KeyID, c.ArmoredKey, c.CreatedAt.Unix(),
	)
	if err != nil {
		return fmt.Errorf("failed to upsert contact: %w", err)
	}
	return nil
}

// BulkUpsertContacts 批次插入（已存在的 contact_email 略過，不覆蓋）
func (s *SQLiteStore) BulkUpsertContacts(ownerEmail string, contacts []ContactKey) (int, []string, error) {
	if len(contacts) == 0 {
		return 0, nil, nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return 0, nil, fmt.Errorf("failed to begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	saved := 0
	skipped := make([]string, 0)
	now := time.Now().UTC().Unix()

	for i := range contacts {
		c := contacts[i]
		if c.ContactEmail == "" || c.ArmoredKey == "" || c.Fingerprint == "" {
			continue
		}
		if c.CreatedAt.IsZero() {
			c.CreatedAt = time.Unix(now, 0).UTC()
		}
		res, err := tx.Exec(
			`INSERT OR IGNORE INTO contact_keys
			 (owner_email, contact_email, name, fingerprint, key_id, armored_key, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			ownerEmail, c.ContactEmail, c.Name, c.Fingerprint, c.KeyID, c.ArmoredKey, c.CreatedAt.Unix(),
		)
		if err != nil {
			return saved, skipped, fmt.Errorf("failed to insert contact %s: %w", c.ContactEmail, err)
		}
		rows, err := res.RowsAffected()
		if err != nil {
			return saved, skipped, err
		}
		if rows == 1 {
			saved++
		} else {
			skipped = append(skipped, c.ContactEmail)
		}
	}
	if err := tx.Commit(); err != nil {
		return saved, skipped, fmt.Errorf("failed to commit: %w", err)
	}
	return saved, skipped, nil
}

// DeleteContact 刪除某使用者的單一聯絡人
func (s *SQLiteStore) DeleteContact(ownerEmail, contactEmail string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.Exec(
		`DELETE FROM contact_keys WHERE owner_email = ? AND contact_email = ?`,
		ownerEmail, contactEmail,
	)
	if err != nil {
		return fmt.Errorf("failed to delete contact: %w", err)
	}
	return nil
}

// GetKeyring 取得使用者之個人金鑰包（無則回傳 nil）
func (s *SQLiteStore) GetKeyring(ownerEmail string) (*Keyring, error) {
	var k Keyring
	var updatedAt int64
	err := s.db.QueryRow(
		`SELECT public_key_armored, encrypted_private_key, fingerprint, key_id, updated_at
		 FROM personal_keyrings WHERE owner_email = ?`,
		ownerEmail,
	).Scan(&k.PublicKeyArmored, &k.EncryptedPrivateKeyArmored, &k.Fingerprint, &k.KeyID, &updatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("failed to get keyring: %w", err)
	}
	k.Email = ownerEmail
	k.UpdatedAt = time.Unix(updatedAt, 0).UTC()
	return &k, nil
}

// SaveKeyring 儲存或更新使用者之個人金鑰包（覆蓋既有）
func (s *SQLiteStore) SaveKeyring(k *Keyring) error {
	if k.Email == "" {
		return errors.New("email is required")
	}
	if k.PublicKeyArmored == "" || k.EncryptedPrivateKeyArmored == "" {
		return errors.New("publicKeyArmored and encryptedPrivateKeyArmored are required")
	}
	if k.UpdatedAt.IsZero() {
		k.UpdatedAt = time.Now().UTC()
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.Exec(
		`INSERT INTO personal_keyrings (owner_email, public_key_armored, encrypted_private_key, fingerprint, key_id, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?)
		 ON CONFLICT(owner_email) DO UPDATE SET
			public_key_armored = excluded.public_key_armored,
			encrypted_private_key = excluded.encrypted_private_key,
			fingerprint = excluded.fingerprint,
			key_id = excluded.key_id,
			updated_at = excluded.updated_at`,
		k.Email, k.PublicKeyArmored, k.EncryptedPrivateKeyArmored, k.Fingerprint, k.KeyID, k.UpdatedAt.Unix(),
	)
	if err != nil {
		return fmt.Errorf("failed to save keyring: %w", err)
	}
	return nil
}

// DeleteKeyring 刪除使用者之個人金鑰包
func (s *SQLiteStore) DeleteKeyring(ownerEmail string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.Exec(
		`DELETE FROM personal_keyrings WHERE owner_email = ?`,
		ownerEmail,
	)
	if err != nil {
		return fmt.Errorf("failed to delete keyring: %w", err)
	}
	return nil
}

// MigrateLegacyKeyrings 掃描 dataDir/keyrings/*.json，匯入尚未存在於 SQLite 之金鑰包，匯入後刪除檔案
func (s *SQLiteStore) MigrateLegacyKeyrings(dataDir string) (int, error) {
	keyringDir := filepath.Join(dataDir, "keyrings")
	entries, err := os.ReadDir(keyringDir)
	if errors.Is(err, os.ErrNotExist) {
		return 0, nil
	}
	if err != nil {
		return 0, fmt.Errorf("failed to read keyring dir: %w", err)
	}

	migrated := 0
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		path := filepath.Join(keyringDir, entry.Name())
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		var payload Keyring
		if err := json.Unmarshal(data, &payload); err != nil {
			continue
		}
		if payload.Email == "" || payload.EncryptedPrivateKeyArmored == "" || payload.PublicKeyArmored == "" {
			continue
		}
		if err := s.SaveKeyring(&payload); err != nil {
			return migrated, fmt.Errorf("failed to migrate %s: %w", entry.Name(), err)
		}
		_ = os.Remove(path)
		migrated++
	}
	// 刪除空目錄（若還有其他檔案則保留）
	if remaining, _ := os.ReadDir(keyringDir); len(remaining) == 0 {
		_ = os.Remove(keyringDir)
	}
	return migrated, nil
}

// GetTwoFA 取得使用者之兩步驟驗證設定（無則回傳 nil）
func (s *SQLiteStore) GetTwoFA(ownerEmail string) (*TwoFA, error) {
	var t TwoFA
	var backupJSON string
	var enabledAt int64
	err := s.db.QueryRow(
		`SELECT secret, backup_code_hashes, enabled_at FROM two_fa WHERE owner_email = ?`,
		ownerEmail,
	).Scan(&t.Secret, &backupJSON, &enabledAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("failed to get two_fa: %w", err)
	}
	t.OwnerEmail = ownerEmail
	t.EnabledAt = time.Unix(enabledAt, 0).UTC()
	if err := json.Unmarshal([]byte(backupJSON), &t.BackupHashes); err != nil {
		t.BackupHashes = nil
	}
	return &t, nil
}

// SaveTwoFA 儲存或更新使用者之兩步驟驗證設定
func (s *SQLiteStore) SaveTwoFA(t *TwoFA) error {
	if t.OwnerEmail == "" || t.Secret == "" {
		return errors.New("owner_email and secret are required")
	}
	if t.BackupHashes == nil {
		t.BackupHashes = []string{}
	}
	backupJSON, err := json.Marshal(t.BackupHashes)
	if err != nil {
		return fmt.Errorf("failed to marshal backup codes: %w", err)
	}
	if t.EnabledAt.IsZero() {
		t.EnabledAt = time.Now().UTC()
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err = s.db.Exec(
		`INSERT INTO two_fa (owner_email, secret, backup_code_hashes, enabled_at)
		 VALUES (?, ?, ?, ?)
		 ON CONFLICT(owner_email) DO UPDATE SET
			secret = excluded.secret,
			backup_code_hashes = excluded.backup_code_hashes,
			enabled_at = excluded.enabled_at`,
		t.OwnerEmail, t.Secret, string(backupJSON), t.EnabledAt.Unix(),
	)
	if err != nil {
		return fmt.Errorf("failed to save two_fa: %w", err)
	}
	return nil
}

// DeleteTwoFA 刪除使用者之兩步驟驗證設定
func (s *SQLiteStore) DeleteTwoFA(ownerEmail string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.Exec(`DELETE FROM two_fa WHERE owner_email = ?`, ownerEmail)
	if err != nil {
		return fmt.Errorf("failed to delete two_fa: %w", err)
	}
	return nil
}
