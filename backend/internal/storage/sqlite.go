package storage

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/johnwmail/e2mail/backend/internal/crypto"
	_ "modernc.org/sqlite"
)

// ContactKey 儲存於 SQLite 之聯絡人公鑰（DB 內全欄位 DEK 加密，struct 為明文視圖）
type ContactKey struct {
	OwnerEmail   string
	ContactEmail string
	Name         string
	Fingerprint  string
	KeyID        string
	ArmoredKey   string
	CreatedAt    time.Time
}

// Keyring 儲存於 SQLite 之個人 PGP 金鑰包。
// public/fingerprint/key_id 以 WrapField(DEK) 加密；
// encrypted_private_key 保留既有格式（handler 層 crypto.Encrypt(DEK, armored) 之 raw base64）。
type Keyring struct {
	Email                      string    `json:"email"`
	PublicKeyArmored           string    `json:"publicKeyArmored"`
	EncryptedPrivateKeyArmored string    `json:"encryptedPrivateKeyArmored"`
	Fingerprint                string    `json:"fingerprint"`
	KeyID                      string    `json:"keyId"`
	UpdatedAt                  time.Time `json:"updatedAt"`
}

// TwoFA 儲存於 SQLite 之兩步驟驗證設定（備份碼以 SHA-256 hash 儲存；secret 為 DEK 密文）
type TwoFA struct {
	OwnerEmail   string
	Secret       string
	BackupHashes []string
	EnabledAt    time.Time
}

// Account 儲存於 SQLite 之郵件帳號設定。
// DB 欄位：owner_id(hash)、label/email/hosts/username(WrapField DEK 密文)、enc_*_password(既有 DEK raw base64)。
// struct 欄位保持明文視圖，加解密於 storage 邊界完成。
type Account struct {
	ID                    string    `json:"id"`
	UserEmail             string    `json:"-"` // 登入者（owner），由查詢參數回填
	Label                 string    `json:"label"`
	Email                 string    `json:"email"`
	IMAPHost              string    `json:"imapHost"`
	IMAPPort              int       `json:"imapPort"`
	IMAPUseTLS            bool      `json:"imapUseTls"`
	IMAPAllowInsecureTLS  bool      `json:"imapAllowInsecureTls"`
	SMTPHost              string    `json:"smtpHost"`
	SMTPPort              int       `json:"smtpPort"`
	SMTPUseTLS            bool      `json:"smtpUseTls"`
	SMTPAllowInsecureTLS  bool      `json:"smtpAllowInsecureTls"`
	SieveHost             string    `json:"sieveHost"`
	SievePort             int       `json:"sievePort"`
	SieveUseTLS           bool      `json:"sieveUseTls"`
	SieveAllowInsecureTLS bool      `json:"sieveAllowInsecureTls"`
	Username              string    `json:"username"`
	EncIMAPPassword       string    `json:"-"` // AES-GCM(DEK, imap_password)
	EncSMTPPassword       string    `json:"-"` // AES-GCM(DEK, smtp_password)
	IsDefault             bool      `json:"isDefault"`
	SortOrder             int       `json:"sortOrder"`
	CreatedAt             time.Time `json:"createdAt"`
	UpdatedAt             time.Time `json:"updatedAt"`
}

// UserCredential 儲存於 SQLite 之 per-user 憑證包（包裹 DEK）。
// UserEmail 欄為呼叫者回填之明文；DB 主鍵為 owner_id 盲索引。
type UserCredential struct {
	UserEmail  string    `json:"userEmail"`
	Salt       []byte    `json:"salt"`
	WrappedDEK string    `json:"wrappedDek"` // AES-GCM(MasterKey, DEK)
	CreatedAt  time.Time `json:"createdAt"`
	UpdatedAt  time.Time `json:"updatedAt"`
}

// Contact 通訊錄聯絡人（通用地址簿，非 PGP 專用）。DB 內容欄加密；email 索引欄為盲哈希。
type Contact struct {
	ID          string    `json:"id"`
	OwnerEmail  string    `json:"-"`
	Email       string    `json:"email"`
	DisplayName string    `json:"displayName"`
	GivenName   string    `json:"givenName"`
	FamilyName  string    `json:"familyName"`
	AvatarPath  string    `json:"-"` // 內容為 uuid 檔名，非敏感，保留明文
	HasAvatar   bool      `json:"hasAvatar"`
	Note        string    `json:"note"`
	Source      string    `json:"source"`
	CreatedAt   time.Time `json:"createdAt"`
	UpdatedAt   time.Time `json:"updatedAt"`
}

// Store SQLite 儲存介面。
// 內容函數（讀寫加密欄）需傳 dek；純鍵函數（hash 索引、opaque uuid）不需。
type Store interface {
	// Contacts (PGP 公鑰)
	ListContacts(ownerEmail string, dek []byte) ([]ContactKey, error)
	GetContact(ownerEmail, contactEmail string, dek []byte) (*ContactKey, error)
	UpsertContact(contact ContactKey, dek []byte) error
	BulkUpsertContacts(ownerEmail string, contacts []ContactKey, dek []byte) (saved int, skipped []string, err error)
	DeleteContact(ownerEmail, contactEmail string) (int64, error)

	// Address book (通用通訊錄)
	ListAddressContacts(ownerEmail string, query string, limit, offset int, dek []byte) ([]Contact, error)
	GetAddressContact(ownerEmail, id string, dek []byte) (*Contact, error)
	GetAddressContactByEmail(ownerEmail, email string, dek []byte) (*Contact, error)
	CreateAddressContact(c *Contact, dek []byte) error
	UpdateAddressContact(c *Contact, dek []byte) error
	DeleteAddressContact(ownerEmail, id string) (int64, error)
	CountAddressContacts(ownerEmail string) (int, error)
	ResolveAddressContacts(ownerEmail string, emails []string, dek []byte) (map[string]*Contact, error)

	// Personal keyring
	GetKeyring(ownerEmail string, dek []byte) (*Keyring, error)
	SaveKeyring(keyring *Keyring, dek []byte) error
	DeleteKeyring(ownerEmail string) error

	// Two-factor authentication
	GetTwoFA(ownerEmail string) (*TwoFA, error)
	SaveTwoFA(t *TwoFA) error
	DeleteTwoFA(ownerEmail string) error

	// Accounts (multi-account registry, per-user)
	ListAccounts(userEmail string, dek []byte) ([]Account, error)
	GetAccount(userEmail, accountID string, dek []byte) (*Account, error)
	CreateAccount(acc *Account, dek []byte) error
	UpdateAccount(acc *Account, dek []byte) error
	DeleteAccount(userEmail, accountID string) error
	SetDefaultAccount(userEmail, accountID string) error
	CountAccounts(userEmail string) (int, error)

	// User credentials (wrapped DEK per user)
	GetUserCredential(userEmail string) (*UserCredential, error)
	CreateUserCredential(cred *UserCredential) error
	UpdateUserCredential(cred *UserCredential) error

	// Folder display prefs (e2Mail-only, per account; not IMAP subscription)
	ListFolderPrefs(userEmail, accountID string, dek []byte) (map[string]bool, error)
	SetFolderPref(userEmail, accountID, folderName string, visible bool, dek []byte) error

	// Folder order (top-level folder display order, per account)
	GetFolderOrder(userEmail, accountID string, dek []byte) ([]string, error)
	SetFolderOrder(userEmail, accountID string, orderedNames []string, dek []byte) error

	// User prefs (generic per-user key-value settings, e.g. thread mode)
	GetUserPref(userEmail, key string, dek []byte) (string, error)
	SetUserPref(userEmail, key, value string, dek []byte) error

	// Durable device sessions (P1.15): EncryptedDEK is SESSION_SECRET-wrapped, not DEK.
	UpsertDeviceSession(row DeviceSession, dek []byte) error
	GetDeviceSession(sessionID string, dek []byte) (*DeviceSession, error)
	ListDeviceSessions() ([]DeviceSession, error)
	DeleteDeviceSession(sessionID string) error
	TouchDeviceSession(sessionID string) error

	// Push device tokens (token/account_ids/timezone DEK-encrypted)
	UpsertPushDevice(d PushDevice, dek []byte) error
	ListPushDevices(ownerEmail string, dek []byte) ([]PushDevice, error)
	GetPushDeviceByToken(token string, dek []byte) (*PushDevice, error)
	DeletePushDevice(ownerEmail, token string) error
	DeletePushDevicesBySession(sessionID string) error

	// Lifecycle
	MigrateLegacyKeyrings(dataDir string) (migrated int, err error)
	Close() error
}

const schema = `
CREATE TABLE IF NOT EXISTS users (
	owner_id        TEXT NOT NULL PRIMARY KEY,
	salt            BLOB NOT NULL,
	wrapped_dek     TEXT NOT NULL,
	pending_encrypt INTEGER NOT NULL DEFAULT 0,
	created_at      INTEGER NOT NULL,
	updated_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS two_fa (
	owner_id           TEXT NOT NULL PRIMARY KEY,
	secret             TEXT NOT NULL,
	backup_code_hashes TEXT NOT NULL DEFAULT '[]',
	enabled_at         INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS personal_keyrings (
	owner_id               TEXT NOT NULL PRIMARY KEY,
	public_key_armored     TEXT NOT NULL,
	encrypted_private_key  TEXT NOT NULL,
	fingerprint            TEXT NOT NULL,
	key_id                 TEXT NOT NULL DEFAULT '',
	updated_at             INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS accounts (
	id                      TEXT NOT NULL PRIMARY KEY,
	owner_id                TEXT NOT NULL,
	label                   TEXT NOT NULL DEFAULT '',
	email                   TEXT NOT NULL DEFAULT '',
	imap_host               TEXT NOT NULL DEFAULT '',
	imap_port               INTEGER NOT NULL,
	imap_use_tls            INTEGER NOT NULL DEFAULT 1,
	imap_allow_insecure_tls INTEGER NOT NULL DEFAULT 0,
	smtp_host               TEXT NOT NULL DEFAULT '',
	smtp_port               INTEGER NOT NULL,
	smtp_use_tls            INTEGER NOT NULL DEFAULT 1,
	smtp_allow_insecure_tls INTEGER NOT NULL DEFAULT 0,
	sieve_host              TEXT NOT NULL DEFAULT '',
	sieve_port              INTEGER NOT NULL DEFAULT 0,
	sieve_use_tls           INTEGER NOT NULL DEFAULT 1,
	sieve_allow_insecure_tls INTEGER NOT NULL DEFAULT 0,
	username                TEXT NOT NULL DEFAULT '',
	enc_imap_password       TEXT NOT NULL,
	enc_smtp_password       TEXT NOT NULL,
	is_default              INTEGER NOT NULL DEFAULT 0,
	sort_order              INTEGER NOT NULL DEFAULT 0,
	created_at              INTEGER NOT NULL,
	updated_at              INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_accounts_owner ON accounts(owner_id);

CREATE TABLE IF NOT EXISTS contact_keys (
	owner_id       TEXT NOT NULL,
	email_hash     TEXT NOT NULL,
	contact_email  TEXT NOT NULL,
	name           TEXT NOT NULL DEFAULT '',
	fingerprint    TEXT NOT NULL,
	key_id         TEXT NOT NULL DEFAULT '',
	armored_key    TEXT NOT NULL,
	created_at     INTEGER NOT NULL,
	PRIMARY KEY (owner_id, email_hash)
);
CREATE INDEX IF NOT EXISTS idx_contact_keys_owner ON contact_keys(owner_id);

CREATE TABLE IF NOT EXISTS contacts (
	id           TEXT NOT NULL PRIMARY KEY,
	owner_id     TEXT NOT NULL,
	email_hash   TEXT NOT NULL,
	email        TEXT NOT NULL DEFAULT '',
	display_name TEXT NOT NULL DEFAULT '',
	given_name   TEXT NOT NULL DEFAULT '',
	family_name  TEXT NOT NULL DEFAULT '',
	avatar_path  TEXT NOT NULL DEFAULT '',
	note         TEXT NOT NULL DEFAULT '',
	source       TEXT NOT NULL DEFAULT 'manual',
	created_at   INTEGER NOT NULL,
	updated_at   INTEGER NOT NULL,
	UNIQUE(owner_id, email_hash)
);
CREATE INDEX IF NOT EXISTS idx_contacts_owner ON contacts(owner_id);
CREATE INDEX IF NOT EXISTS idx_contacts_owner_email ON contacts(owner_id, email_hash);

CREATE TABLE IF NOT EXISTS folder_prefs (
	owner_id    TEXT NOT NULL,
	account_id  TEXT NOT NULL,
	name_hash   TEXT NOT NULL,
	folder_name TEXT NOT NULL,
	visible     INTEGER NOT NULL DEFAULT 1,
	PRIMARY KEY (owner_id, account_id, name_hash)
);
CREATE INDEX IF NOT EXISTS idx_folder_prefs_account ON folder_prefs(account_id);

CREATE TABLE IF NOT EXISTS folder_order (
	owner_id    TEXT NOT NULL,
	account_id  TEXT NOT NULL,
	name_hash   TEXT NOT NULL,
	folder_name TEXT NOT NULL,
	sort_index  INTEGER NOT NULL DEFAULT 0,
	PRIMARY KEY (account_id, name_hash)
);
CREATE INDEX IF NOT EXISTS idx_folder_order_account ON folder_order(account_id);

CREATE TABLE IF NOT EXISTS user_prefs (
	owner_id   TEXT NOT NULL,
	pref_key   TEXT NOT NULL,
	pref_value TEXT NOT NULL DEFAULT '',
	updated_at INTEGER NOT NULL,
	PRIMARY KEY (owner_id, pref_key)
);
CREATE INDEX IF NOT EXISTS idx_user_prefs_owner ON user_prefs(owner_id);

CREATE TABLE IF NOT EXISTS device_sessions (
	session_id     TEXT NOT NULL PRIMARY KEY,
	owner_id       TEXT NOT NULL,
	enc_dek        TEXT NOT NULL,
	owner_email    TEXT NOT NULL,
	last_active_at INTEGER NOT NULL,
	created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_device_sessions_owner ON device_sessions(owner_id);

CREATE TABLE IF NOT EXISTS push_devices (
	token_hash  TEXT NOT NULL PRIMARY KEY,
	owner_id    TEXT NOT NULL,
	session_id  TEXT NOT NULL,
	platform    TEXT NOT NULL,
	token       TEXT NOT NULL,
	account_ids TEXT NOT NULL DEFAULT '',
	timezone    TEXT NOT NULL DEFAULT '',
	created_at  INTEGER NOT NULL,
	updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_push_devices_owner ON push_devices(owner_id);
CREATE INDEX IF NOT EXISTS idx_push_devices_session ON push_devices(session_id);
`

// SQLiteStore SQLite 儲存實作
type SQLiteStore struct {
	db *sql.DB
	mu sync.Mutex
}

// NewSQLiteStore 於 dataDir/e2Mail.db 建立並初始化 SQLite 儲存。
func NewSQLiteStore(dataDir string) (*SQLiteStore, error) {
	if err := os.MkdirAll(dataDir, 0700); err != nil {
		return nil, fmt.Errorf("failed to create storage dir: %w", err)
	}
	dbPath := filepath.Join(dataDir, "e2Mail.db")
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
	if _, err := db.Exec(`PRAGMA user_version = 2`); err != nil {
		log.Printf("[STORAGE] WARN: set user_version failed: %v", err)
	}
	return &SQLiteStore{db: db}, nil
}

func (s *SQLiteStore) Close() error {
	return s.db.Close()
}

// ===== 加密欄 helper（storage 邊界統一 wrap/unwrap） =====

func wrapFields(dek []byte, vals ...string) ([]string, error) {
	out := make([]string, len(vals))
	for i, v := range vals {
		w, err := crypto.WrapField(dek, v)
		if err != nil {
			return nil, err
		}
		out[i] = w
	}
	return out, nil
}

func unwrapFields(dek []byte, vals ...string) ([]string, error) {
	out := make([]string, len(vals))
	for i, v := range vals {
		u, err := crypto.UnwrapField(dek, v)
		if err != nil {
			return nil, err
		}
		out[i] = u
	}
	return out, nil
}

func emailIndex(email string) string { return crypto.OwnerID(email) }
func nameIndex(folder string) string { return crypto.HashID(folder) }

// ===== Contacts (PGP 公鑰表) =====

func scanContactKey(rows interface{ Scan(...any) error }, ownerEmail string, dek []byte) (*ContactKey, error) {
	var c ContactKey
	var emailHash, encEmail, encName, encFP, encKeyID, encArmored string
	var createdAt int64
	if err := rows.Scan(&emailHash, &encEmail, &encName, &encFP, &encKeyID, &encArmored, &createdAt); err != nil {
		return nil, err
	}
	plain, err := unwrapFields(dek, encEmail, encName, encFP, encKeyID, encArmored)
	if err != nil {
		return nil, fmt.Errorf("failed to unwrap contact: %w", err)
	}
	c.ContactEmail, c.Name, c.Fingerprint, c.KeyID, c.ArmoredKey = plain[0], plain[1], plain[2], plain[3], plain[4]
	c.OwnerEmail = ownerEmail
	c.CreatedAt = time.Unix(createdAt, 0).UTC()
	return &c, nil
}

// ListContacts 取得某使用者所有聯絡人公鑰（依 contact_email 排序）
func (s *SQLiteStore) ListContacts(ownerEmail string, dek []byte) ([]ContactKey, error) {
	rows, err := s.db.Query(
		`SELECT email_hash, contact_email, name, fingerprint, key_id, armored_key, created_at
		 FROM contact_keys WHERE owner_id = ? ORDER BY created_at ASC`,
		crypto.OwnerID(ownerEmail),
	)
	if err != nil {
		return nil, fmt.Errorf("failed to query contacts: %w", err)
	}
	defer func() { _ = rows.Close() }()

	out := make([]ContactKey, 0)
	for rows.Next() {
		c, err := scanContactKey(rows, ownerEmail, dek)
		if err != nil {
			return nil, fmt.Errorf("failed to scan contact: %w", err)
		}
		out = append(out, *c)
	}
	sort.Slice(out, func(i, j int) bool {
		return strings.ToLower(out[i].ContactEmail) < strings.ToLower(out[j].ContactEmail)
	})
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

// GetContact 取得單一聯絡人公鑰
func (s *SQLiteStore) GetContact(ownerEmail, contactEmail string, dek []byte) (*ContactKey, error) {
	row := s.db.QueryRow(
		`SELECT email_hash, contact_email, name, fingerprint, key_id, armored_key, created_at
		 FROM contact_keys WHERE owner_id = ? AND email_hash = ?`,
		crypto.OwnerID(ownerEmail), emailIndex(contactEmail),
	)
	c, err := scanContactKey(row, ownerEmail, dek)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("failed to get contact: %w", err)
	}
	return c, nil
}

// UpsertContact 插入或更新單一聯絡人公鑰（覆蓋既有同 email 聯絡人）
func (s *SQLiteStore) UpsertContact(c ContactKey, dek []byte) error {
	if c.OwnerEmail == "" || c.ContactEmail == "" {
		return errors.New("owner_email and contact_email are required")
	}
	if c.ArmoredKey == "" || c.Fingerprint == "" {
		return errors.New("armored_key and fingerprint are required")
	}
	if c.CreatedAt.IsZero() {
		c.CreatedAt = time.Now().UTC()
	}
	wrapped, err := wrapFields(dek, c.ContactEmail, c.Name, c.Fingerprint, c.KeyID, c.ArmoredKey)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err = s.db.Exec(
		`INSERT INTO contact_keys (owner_id, email_hash, contact_email, name, fingerprint, key_id, armored_key, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(owner_id, email_hash) DO UPDATE SET
			contact_email = excluded.contact_email,
			name = excluded.name,
			fingerprint = excluded.fingerprint,
			key_id = excluded.key_id,
			armored_key = excluded.armored_key`,
		crypto.OwnerID(c.OwnerEmail), emailIndex(c.ContactEmail),
		wrapped[0], wrapped[1], wrapped[2], wrapped[3], wrapped[4], c.CreatedAt.Unix(),
	)
	if err != nil {
		return fmt.Errorf("failed to upsert contact: %w", err)
	}
	return nil
}

// BulkUpsertContacts 批次插入（已存在的 contact email 略過，不覆蓋）
func (s *SQLiteStore) BulkUpsertContacts(ownerEmail string, contacts []ContactKey, dek []byte) (int, []string, error) {
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
	ownerID := crypto.OwnerID(ownerEmail)

	for i := range contacts {
		c := contacts[i]
		if c.ContactEmail == "" || c.ArmoredKey == "" || c.Fingerprint == "" {
			continue
		}
		if c.CreatedAt.IsZero() {
			c.CreatedAt = time.Unix(now, 0).UTC()
		}
		wrapped, err := wrapFields(dek, c.ContactEmail, c.Name, c.Fingerprint, c.KeyID, c.ArmoredKey)
		if err != nil {
			return saved, skipped, err
		}
		res, err := tx.Exec(
			`INSERT OR IGNORE INTO contact_keys
			 (owner_id, email_hash, contact_email, name, fingerprint, key_id, armored_key, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			ownerID, emailIndex(c.ContactEmail),
			wrapped[0], wrapped[1], wrapped[2], wrapped[3], wrapped[4], c.CreatedAt.Unix(),
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
func (s *SQLiteStore) DeleteContact(ownerEmail, contactEmail string) (int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	res, err := s.db.Exec(
		`DELETE FROM contact_keys WHERE owner_id = ? AND email_hash = ?`,
		crypto.OwnerID(ownerEmail), emailIndex(contactEmail),
	)
	if err != nil {
		return 0, fmt.Errorf("failed to delete contact: %w", err)
	}
	return res.RowsAffected()
}

// ===== Address book (通用通訊錄) =====

const contactSelectCols = `id, email_hash, email, display_name, given_name, family_name, avatar_path, note, source, created_at, updated_at`

func scanAddressContact(rows interface{ Scan(...any) error }, ownerEmail string, dek []byte) (*Contact, error) {
	var c Contact
	var encEmail, encDisplay, encGiven, encFamily, encNote, encSource string
	var emailHash string
	var createdAt, updatedAt int64
	err := rows.Scan(&c.ID, &emailHash, &encEmail, &encDisplay, &encGiven, &encFamily, &c.AvatarPath, &encNote, &encSource, &createdAt, &updatedAt)
	if err != nil {
		return nil, err
	}
	plain, err := unwrapFields(dek, encEmail, encDisplay, encGiven, encFamily, encNote, encSource)
	if err != nil {
		return nil, fmt.Errorf("failed to unwrap contact %s: %w", c.ID, err)
	}
	c.Email, c.DisplayName, c.GivenName, c.FamilyName, c.Note, c.Source =
		plain[0], plain[1], plain[2], plain[3], plain[4], plain[5]
	c.OwnerEmail = ownerEmail
	c.HasAvatar = c.AvatarPath != ""
	c.CreatedAt = time.Unix(createdAt, 0).UTC()
	c.UpdatedAt = time.Unix(updatedAt, 0).UTC()
	return &c, nil
}

// ListAddressContacts 列出通訊錄。
// q 搜尋於 v2 改為記憶體過濾（密文無法 SQL LIKE）：讀 owner 全量 → 解密 →
// 對 email/display_name/note 做 case-insensitive substring → 排序 → limit/offset。
func (s *SQLiteStore) ListAddressContacts(ownerEmail string, query string, limit, offset int, dek []byte) ([]Contact, error) {
	rows, err := s.db.Query(
		`SELECT `+contactSelectCols+` FROM contacts WHERE owner_id = ?`,
		crypto.OwnerID(ownerEmail),
	)
	if err != nil {
		return nil, fmt.Errorf("failed to list contacts: %w", err)
	}
	defer func() { _ = rows.Close() }()

	all := make([]Contact, 0)
	for rows.Next() {
		c, err := scanAddressContact(rows, ownerEmail, dek)
		if err != nil {
			return nil, err
		}
		all = append(all, *c)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	q := strings.ToLower(strings.TrimSpace(query))
	filtered := all
	if q != "" {
		filtered = make([]Contact, 0, len(all))
		for _, c := range all {
			if strings.Contains(strings.ToLower(c.Email), q) ||
				strings.Contains(strings.ToLower(c.DisplayName), q) ||
				strings.Contains(strings.ToLower(c.Note), q) {
				filtered = append(filtered, c)
			}
		}
	}
	sort.Slice(filtered, func(i, j int) bool {
		di, dj := strings.ToLower(filtered[i].DisplayName), strings.ToLower(filtered[j].DisplayName)
		if di != dj {
			return di < dj
		}
		return strings.ToLower(filtered[i].Email) < strings.ToLower(filtered[j].Email)
	})

	if offset > 0 {
		if offset >= len(filtered) {
			return []Contact{}, nil
		}
		filtered = filtered[offset:]
	}
	if limit > 0 && limit < len(filtered) {
		filtered = filtered[:limit]
	}
	return filtered, nil
}

// GetAddressContact 以 id 取得單一聯絡人
func (s *SQLiteStore) GetAddressContact(ownerEmail, id string, dek []byte) (*Contact, error) {
	row := s.db.QueryRow(`SELECT `+contactSelectCols+` FROM contacts WHERE owner_id = ? AND id = ?`, crypto.OwnerID(ownerEmail), id)
	c, err := scanAddressContact(row, ownerEmail, dek)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("failed to get contact: %w", err)
	}
	return c, nil
}

// GetAddressContactByEmail 以 email 取得單一聯絡人（盲索引查詢）
func (s *SQLiteStore) GetAddressContactByEmail(ownerEmail, email string, dek []byte) (*Contact, error) {
	email = strings.ToLower(strings.TrimSpace(email))
	row := s.db.QueryRow(`SELECT `+contactSelectCols+` FROM contacts WHERE owner_id = ? AND email_hash = ?`,
		crypto.OwnerID(ownerEmail), emailIndex(email))
	c, err := scanAddressContact(row, ownerEmail, dek)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("failed to get contact by email: %w", err)
	}
	return c, nil
}

// CreateAddressContact 新增聯絡人
func (s *SQLiteStore) CreateAddressContact(c *Contact, dek []byte) error {
	if c.OwnerEmail == "" || c.Email == "" {
		return errors.New("owner_email and email are required")
	}
	c.Email = strings.ToLower(strings.TrimSpace(c.Email))
	if c.ID == "" {
		c.ID = uuid.New().String()
	}
	now := time.Now().UTC()
	if c.CreatedAt.IsZero() {
		c.CreatedAt = now
	}
	c.UpdatedAt = now
	if c.Source == "" {
		c.Source = "manual"
	}
	wrapped, err := wrapFields(dek, c.Email, c.DisplayName, c.GivenName, c.FamilyName, c.Note, c.Source)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err = s.db.Exec(
		`INSERT INTO contacts (id, owner_id, email_hash, email, display_name, given_name, family_name, avatar_path, note, source, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		c.ID, crypto.OwnerID(c.OwnerEmail), emailIndex(c.Email),
		wrapped[0], wrapped[1], wrapped[2], wrapped[3], c.AvatarPath, wrapped[4], wrapped[5],
		c.CreatedAt.Unix(), c.UpdatedAt.Unix())
	if err != nil {
		return fmt.Errorf("failed to create contact: %w", err)
	}
	c.HasAvatar = c.AvatarPath != ""
	return nil
}

// UpdateAddressContact 更新聯絡人（以 id + owner 為鍵）
func (s *SQLiteStore) UpdateAddressContact(c *Contact, dek []byte) error {
	if c.ID == "" || c.OwnerEmail == "" {
		return errors.New("id and owner_email are required")
	}
	c.Email = strings.ToLower(strings.TrimSpace(c.Email))
	c.UpdatedAt = time.Now().UTC()
	wrapped, err := wrapFields(dek, c.Email, c.DisplayName, c.GivenName, c.FamilyName, c.Note, c.Source)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	res, err := s.db.Exec(
		`UPDATE contacts SET email_hash = ?, email = ?, display_name = ?, given_name = ?, family_name = ?, avatar_path = ?, note = ?, source = ?, updated_at = ?
		 WHERE owner_id = ? AND id = ?`,
		emailIndex(c.Email), wrapped[0], wrapped[1], wrapped[2], wrapped[3], c.AvatarPath, wrapped[4], wrapped[5], c.UpdatedAt.Unix(),
		crypto.OwnerID(c.OwnerEmail), c.ID)
	if err != nil {
		return fmt.Errorf("failed to update contact: %w", err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return errors.New("contact not found")
	}
	c.HasAvatar = c.AvatarPath != ""
	return nil
}

// DeleteAddressContact 刪除聯絡人
func (s *SQLiteStore) DeleteAddressContact(ownerEmail, id string) (int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	res, err := s.db.Exec(`DELETE FROM contacts WHERE owner_id = ? AND id = ?`, crypto.OwnerID(ownerEmail), id)
	if err != nil {
		return 0, fmt.Errorf("failed to delete contact: %w", err)
	}
	return res.RowsAffected()
}

// CountAddressContacts 計算聯絡人數
func (s *SQLiteStore) CountAddressContacts(ownerEmail string) (int, error) {
	var n int
	err := s.db.QueryRow(`SELECT COUNT(*) FROM contacts WHERE owner_id = ?`, crypto.OwnerID(ownerEmail)).Scan(&n)
	if err != nil {
		return 0, fmt.Errorf("failed to count contacts: %w", err)
	}
	return n, nil
}

// ResolveAddressContacts 批量以 email 解析聯絡人（最多 100；盲索引 IN 查詢）
func (s *SQLiteStore) ResolveAddressContacts(ownerEmail string, emails []string, dek []byte) (map[string]*Contact, error) {
	if len(emails) == 0 {
		return map[string]*Contact{}, nil
	}
	uniq := make(map[string]struct{})
	normed := make([]string, 0, len(emails))
	for _, e := range emails {
		ne := strings.ToLower(strings.TrimSpace(e))
		if ne == "" {
			continue
		}
		if _, ok := uniq[ne]; !ok {
			uniq[ne] = struct{}{}
			normed = append(normed, ne)
		}
		if len(normed) >= 100 {
			break
		}
	}
	if len(normed) == 0 {
		return map[string]*Contact{}, nil
	}
	hashes := make([]string, 0, len(normed))
	for _, e := range normed {
		hashes = append(hashes, emailIndex(e))
	}
	placeholders := strings.Repeat("?,", len(hashes))
	placeholders = placeholders[:len(placeholders)-1]
	args := make([]any, 0, len(hashes)+1)
	args = append(args, crypto.OwnerID(ownerEmail))
	for _, h := range hashes {
		args = append(args, h)
	}
	q := fmt.Sprintf(`SELECT %s FROM contacts WHERE owner_id = ? AND email_hash IN (%s)`, contactSelectCols, placeholders)
	rows, err := s.db.Query(q, args...)
	if err != nil {
		return nil, fmt.Errorf("failed to resolve contacts: %w", err)
	}
	defer func() { _ = rows.Close() }()
	out := make(map[string]*Contact)
	for rows.Next() {
		c, err := scanAddressContact(rows, ownerEmail, dek)
		if err != nil {
			return nil, err
		}
		out[strings.ToLower(strings.TrimSpace(c.Email))] = c
	}
	return out, rows.Err()
}

// ===== Personal keyring =====

// GetKeyring 取得使用者之個人金鑰包（無則回傳 nil）
func (s *SQLiteStore) GetKeyring(ownerEmail string, dek []byte) (*Keyring, error) {
	var k Keyring
	var encPublic, encFP, encKeyID string
	var updatedAt int64
	err := s.db.QueryRow(
		`SELECT public_key_armored, encrypted_private_key, fingerprint, key_id, updated_at
		 FROM personal_keyrings WHERE owner_id = ?`,
		crypto.OwnerID(ownerEmail),
	).Scan(&encPublic, &k.EncryptedPrivateKeyArmored, &encFP, &encKeyID, &updatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("failed to get keyring: %w", err)
	}
	plain, err := unwrapFields(dek, encPublic, encFP, encKeyID)
	if err != nil {
		return nil, fmt.Errorf("failed to unwrap keyring: %w", err)
	}
	k.PublicKeyArmored, k.Fingerprint, k.KeyID = plain[0], plain[1], plain[2]
	k.Email = ownerEmail
	k.UpdatedAt = time.Unix(updatedAt, 0).UTC()
	return &k, nil
}

// SaveKeyring 儲存或更新使用者之個人金鑰包（覆蓋既有）。
// dek 為空時公開欄以 pending 形式寫入並標記 owner 待轉換（僅供啟動期 legacy 匯入）。
func (s *SQLiteStore) SaveKeyring(k *Keyring, dek []byte) error {
	if k.Email == "" {
		return errors.New("email is required")
	}
	if k.PublicKeyArmored == "" || k.EncryptedPrivateKeyArmored == "" {
		return errors.New("publicKeyArmored and encryptedPrivateKeyArmored are required")
	}
	if k.UpdatedAt.IsZero() {
		k.UpdatedAt = time.Now().UTC()
	}
	wrapped, err := wrapFields(dek, k.PublicKeyArmored, k.Fingerprint, k.KeyID)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err = s.db.Exec(
		`INSERT INTO personal_keyrings (owner_id, public_key_armored, encrypted_private_key, fingerprint, key_id, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?)
		 ON CONFLICT(owner_id) DO UPDATE SET
			public_key_armored = excluded.public_key_armored,
			encrypted_private_key = excluded.encrypted_private_key,
			fingerprint = excluded.fingerprint,
			key_id = excluded.key_id,
			updated_at = excluded.updated_at`,
		crypto.OwnerID(k.Email), wrapped[0], k.EncryptedPrivateKeyArmored, wrapped[1], wrapped[2], k.UpdatedAt.Unix(),
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
	_, err := s.db.Exec(`DELETE FROM personal_keyrings WHERE owner_id = ?`, crypto.OwnerID(ownerEmail))
	if err != nil {
		return fmt.Errorf("failed to delete keyring: %w", err)
	}
	return nil
}

// MigrateLegacyKeyrings 掃描 dataDir/keyrings/*.json，匯入尚未存在於 SQLite 之金鑰包，匯入後刪除檔案。
// 啟動期無 DEK：公開欄以 pending 寫入，待 owner 首次登入 lazy 轉換。
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
		// 已在 DB（上次匯入後刪檔失敗殘留）→ 直接清走檔案
		var exists int
		if err := s.db.QueryRow(`SELECT COUNT(*) FROM personal_keyrings WHERE owner_id = ?`, crypto.OwnerID(payload.Email)).Scan(&exists); err != nil {
			return migrated, err
		}
		if exists > 0 {
			_ = os.Remove(path)
			continue
		}
		if err := s.SaveKeyring(&payload, nil); err != nil {
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

// ===== Two-factor auth =====

// GetTwoFA 取得使用者之兩步驟驗證設定（無則回傳 nil）
func (s *SQLiteStore) GetTwoFA(ownerEmail string) (*TwoFA, error) {
	var t TwoFA
	var backupJSON string
	var enabledAt int64
	err := s.db.QueryRow(
		`SELECT secret, backup_code_hashes, enabled_at FROM two_fa WHERE owner_id = ?`,
		crypto.OwnerID(ownerEmail),
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
		`INSERT INTO two_fa (owner_id, secret, backup_code_hashes, enabled_at)
		 VALUES (?, ?, ?, ?)
		 ON CONFLICT(owner_id) DO UPDATE SET
			secret = excluded.secret,
			backup_code_hashes = excluded.backup_code_hashes,
			enabled_at = excluded.enabled_at`,
		crypto.OwnerID(t.OwnerEmail), t.Secret, string(backupJSON), t.EnabledAt.Unix(),
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
	_, err := s.db.Exec(`DELETE FROM two_fa WHERE owner_id = ?`, crypto.OwnerID(ownerEmail))
	if err != nil {
		return fmt.Errorf("failed to delete two_fa: %w", err)
	}
	return nil
}

// ===== Folder display prefs (e2Mail-only) =====

// ListFolderPrefs 返回帳號各 folder 嘅顯示偏好（visible map）；無記錄嘅 folder 唔喺 map 入面（視作 default）
func (s *SQLiteStore) ListFolderPrefs(userEmail, accountID string, dek []byte) (map[string]bool, error) {
	rows, err := s.db.Query(
		`SELECT folder_name, visible FROM folder_prefs WHERE owner_id = ? AND account_id = ?`,
		crypto.OwnerID(userEmail), accountID,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to list folder prefs: %w", err)
	}
	defer func() { _ = rows.Close() }()
	out := make(map[string]bool)
	for rows.Next() {
		var encName string
		var visible int
		if err := rows.Scan(&encName, &visible); err != nil {
			return nil, err
		}
		name, err := crypto.UnwrapField(dek, encName)
		if err != nil {
			return nil, fmt.Errorf("failed to unwrap folder pref: %w", err)
		}
		out[name] = visible == 1
	}
	return out, rows.Err()
}

// SetFolderPref 設定單一 folder 嘅顯示偏好（upsert）
func (s *SQLiteStore) SetFolderPref(userEmail, accountID, folderName string, visible bool, dek []byte) error {
	encName, err := crypto.WrapField(dek, folderName)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err = s.db.Exec(
		`INSERT INTO folder_prefs (owner_id, account_id, name_hash, folder_name, visible)
		 VALUES (?, ?, ?, ?, ?)
		 ON CONFLICT(owner_id, account_id, name_hash) DO UPDATE SET visible = excluded.visible, folder_name = excluded.folder_name`,
		crypto.OwnerID(userEmail), accountID, nameIndex(folderName), encName, boolInt(visible),
	)
	if err != nil {
		return fmt.Errorf("failed to set folder pref: %w", err)
	}
	return nil
}

// GetFolderOrder 返回帳號頂層 folder 顯示次序（按 sort_index 排序）；無記錄則空
func (s *SQLiteStore) GetFolderOrder(userEmail, accountID string, dek []byte) ([]string, error) {
	rows, err := s.db.Query(
		`SELECT folder_name FROM folder_order WHERE owner_id = ? AND account_id = ? ORDER BY sort_index ASC`,
		crypto.OwnerID(userEmail), accountID,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to get folder order: %w", err)
	}
	defer func() { _ = rows.Close() }()
	var out []string
	for rows.Next() {
		var encName string
		if err := rows.Scan(&encName); err != nil {
			return nil, err
		}
		name, err := crypto.UnwrapField(dek, encName)
		if err != nil {
			return nil, fmt.Errorf("failed to unwrap folder order: %w", err)
		}
		out = append(out, name)
	}
	return out, rows.Err()
}

// SetFolderOrder 重寫帳號頂層 folder 顯示次序（先刪後插）
func (s *SQLiteStore) SetFolderOrder(userEmail, accountID string, orderedNames []string, dek []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("failed to begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.Exec(`DELETE FROM folder_order WHERE owner_id = ? AND account_id = ?`, crypto.OwnerID(userEmail), accountID); err != nil {
		return err
	}
	for i, name := range orderedNames {
		encName, err := crypto.WrapField(dek, name)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(
			`INSERT INTO folder_order (owner_id, account_id, name_hash, folder_name, sort_index) VALUES (?, ?, ?, ?, ?)`,
			crypto.OwnerID(userEmail), accountID, nameIndex(name), encName, i,
		); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// ===== Accounts =====

const accountSelectCols = `id, label, email,
	imap_host, imap_port, imap_use_tls, imap_allow_insecure_tls,
	smtp_host, smtp_port, smtp_use_tls, smtp_allow_insecure_tls,
	sieve_host, sieve_port, sieve_use_tls, sieve_allow_insecure_tls,
	username, enc_imap_password, enc_smtp_password,
	is_default, sort_order, created_at, updated_at`

func scanAccount(rows interface{ Scan(...any) error }, ownerEmail string, dek []byte) (*Account, error) {
	var a Account
	var encLabel, encEmail, encIMAPHost, encSMTPHost, encSieveHost, encUsername string
	var imapUseTLS, imapInsecure, smtpUseTLS, smtpInsecure, sieveUseTLS, sieveInsecure, isDefault int
	var createdAt, updatedAt int64
	err := rows.Scan(
		&a.ID, &encLabel, &encEmail,
		&encIMAPHost, &a.IMAPPort, &imapUseTLS, &imapInsecure,
		&encSMTPHost, &a.SMTPPort, &smtpUseTLS, &smtpInsecure,
		&encSieveHost, &a.SievePort, &sieveUseTLS, &sieveInsecure,
		&encUsername, &a.EncIMAPPassword, &a.EncSMTPPassword,
		&isDefault, &a.SortOrder, &createdAt, &updatedAt,
	)
	if err != nil {
		return nil, err
	}
	plain, err := unwrapFields(dek, encLabel, encEmail, encIMAPHost, encSMTPHost, encSieveHost, encUsername)
	if err != nil {
		return nil, fmt.Errorf("failed to unwrap account %s: %w", a.ID, err)
	}
	a.Label, a.Email, a.IMAPHost, a.SMTPHost, a.SieveHost, a.Username =
		plain[0], plain[1], plain[2], plain[3], plain[4], plain[5]
	a.UserEmail = ownerEmail
	a.IMAPUseTLS = imapUseTLS == 1
	a.IMAPAllowInsecureTLS = imapInsecure == 1
	a.SMTPUseTLS = smtpUseTLS == 1
	a.SMTPAllowInsecureTLS = smtpInsecure == 1
	a.SieveUseTLS = sieveUseTLS == 1
	a.SieveAllowInsecureTLS = sieveInsecure == 1
	a.IsDefault = isDefault == 1
	a.CreatedAt = time.Unix(createdAt, 0).UTC()
	a.UpdatedAt = time.Unix(updatedAt, 0).UTC()
	return &a, nil
}

// ListAccounts 列出某使用者所有帳號（依 sort_order）
func (s *SQLiteStore) ListAccounts(userEmail string, dek []byte) ([]Account, error) {
	rows, err := s.db.Query(
		`SELECT `+accountSelectCols+` FROM accounts WHERE owner_id = ? ORDER BY sort_order ASC, created_at ASC`,
		crypto.OwnerID(userEmail),
	)
	if err != nil {
		return nil, fmt.Errorf("failed to list accounts: %w", err)
	}
	defer func() { _ = rows.Close() }()

	out := make([]Account, 0)
	for rows.Next() {
		a, err := scanAccount(rows, userEmail, dek)
		if err != nil {
			return nil, fmt.Errorf("failed to scan account: %w", err)
		}
		out = append(out, *a)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

// GetAccount 取得單一帳號
func (s *SQLiteStore) GetAccount(userEmail, accountID string, dek []byte) (*Account, error) {
	row := s.db.QueryRow(
		`SELECT `+accountSelectCols+` FROM accounts WHERE owner_id = ? AND id = ?`,
		crypto.OwnerID(userEmail), accountID,
	)
	a, err := scanAccount(row, userEmail, dek)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("failed to get account: %w", err)
	}
	return a, nil
}

// CreateAccount 建立新帳號（內容欄於此 wrap）
func (s *SQLiteStore) CreateAccount(a *Account, dek []byte) error {
	if a.ID == "" {
		a.ID = uuid.New().String()
	}
	if a.EncIMAPPassword == "" || a.EncSMTPPassword == "" {
		return errors.New("enc_imap_password and enc_smtp_password are required")
	}
	now := time.Now().UTC()
	if a.CreatedAt.IsZero() {
		a.CreatedAt = now
	}
	a.UpdatedAt = now
	wrapped, err := wrapFields(dek, a.Label, a.Email, a.IMAPHost, a.SMTPHost, a.SieveHost, a.Username)
	if err != nil {
		return err
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	_, err = s.db.Exec(
		`INSERT INTO accounts (id, owner_id, label, email,
		        imap_host, imap_port, imap_use_tls, imap_allow_insecure_tls,
		        smtp_host, smtp_port, smtp_use_tls, smtp_allow_insecure_tls,
		        sieve_host, sieve_port, sieve_use_tls, sieve_allow_insecure_tls,
		        username, enc_imap_password, enc_smtp_password,
		        is_default, sort_order, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		a.ID, crypto.OwnerID(a.UserEmail), wrapped[0], wrapped[1],
		wrapped[2], a.IMAPPort, boolInt(a.IMAPUseTLS), boolInt(a.IMAPAllowInsecureTLS),
		wrapped[3], a.SMTPPort, boolInt(a.SMTPUseTLS), boolInt(a.SMTPAllowInsecureTLS),
		wrapped[4], a.SievePort, boolInt(a.SieveUseTLS), boolInt(a.SieveAllowInsecureTLS),
		wrapped[5], a.EncIMAPPassword, a.EncSMTPPassword,
		boolInt(a.IsDefault), a.SortOrder, a.CreatedAt.Unix(), a.UpdatedAt.Unix(),
	)
	if err != nil {
		return fmt.Errorf("failed to create account: %w", err)
	}
	return nil
}

// UpdateAccount 更新帳號（內容欄於此 wrap；不含密碼欄位時保留原值，由 caller 決定）
func (s *SQLiteStore) UpdateAccount(a *Account, dek []byte) error {
	if a.ID == "" {
		return errors.New("account id is required")
	}
	a.UpdatedAt = time.Now().UTC()
	wrapped, err := wrapFields(dek, a.Label, a.Email, a.IMAPHost, a.SMTPHost, a.SieveHost, a.Username)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err = s.db.Exec(
		`UPDATE accounts SET
		        label = ?, email = ?,
		        imap_host = ?, imap_port = ?, imap_use_tls = ?, imap_allow_insecure_tls = ?,
		        smtp_host = ?, smtp_port = ?, smtp_use_tls = ?, smtp_allow_insecure_tls = ?,
		        sieve_host = ?, sieve_port = ?, sieve_use_tls = ?, sieve_allow_insecure_tls = ?,
		        username = ?, enc_imap_password = ?, enc_smtp_password = ?,
		        is_default = ?, sort_order = ?, updated_at = ?
		 WHERE owner_id = ? AND id = ?`,
		wrapped[0], wrapped[1],
		wrapped[2], a.IMAPPort, boolInt(a.IMAPUseTLS), boolInt(a.IMAPAllowInsecureTLS),
		wrapped[3], a.SMTPPort, boolInt(a.SMTPUseTLS), boolInt(a.SMTPAllowInsecureTLS),
		wrapped[4], a.SievePort, boolInt(a.SieveUseTLS), boolInt(a.SieveAllowInsecureTLS),
		wrapped[5], a.EncIMAPPassword, a.EncSMTPPassword,
		boolInt(a.IsDefault), a.SortOrder, a.UpdatedAt.Unix(),
		crypto.OwnerID(a.UserEmail), a.ID,
	)
	if err != nil {
		return fmt.Errorf("failed to update account: %w", err)
	}
	return nil
}

// DeleteAccount 刪除帳號
func (s *SQLiteStore) DeleteAccount(userEmail, accountID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.Exec(`DELETE FROM accounts WHERE owner_id = ? AND id = ?`, crypto.OwnerID(userEmail), accountID)
	if err != nil {
		return fmt.Errorf("failed to delete account: %w", err)
	}
	return nil
}

// SetDefaultAccount 將指定帳號設為預設（先清其他，再設目標）
func (s *SQLiteStore) SetDefaultAccount(userEmail, accountID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.Exec(`UPDATE accounts SET is_default = 0 WHERE owner_id = ?`, crypto.OwnerID(userEmail))
	if err != nil {
		return fmt.Errorf("failed to clear defaults: %w", err)
	}
	res, err := s.db.Exec(
		`UPDATE accounts SET is_default = 1, updated_at = ? WHERE owner_id = ? AND id = ?`,
		time.Now().UTC().Unix(), crypto.OwnerID(userEmail), accountID,
	)
	if err != nil {
		return fmt.Errorf("failed to set default: %w", err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return errors.New("account not found")
	}
	return nil
}

// CountAccounts 計算某使用者帳號數量
func (s *SQLiteStore) CountAccounts(userEmail string) (int, error) {
	var n int
	err := s.db.QueryRow(`SELECT COUNT(*) FROM accounts WHERE owner_id = ?`, crypto.OwnerID(userEmail)).Scan(&n)
	if err != nil {
		return 0, fmt.Errorf("failed to count accounts: %w", err)
	}
	return n, nil
}

// ===== User Credentials =====

// GetUserCredential 取得使用者憑證包（無則回傳 nil）
func (s *SQLiteStore) GetUserCredential(userEmail string) (*UserCredential, error) {
	var c UserCredential
	var createdAt, updatedAt int64
	err := s.db.QueryRow(
		`SELECT salt, wrapped_dek, created_at, updated_at FROM users WHERE owner_id = ?`,
		crypto.OwnerID(userEmail),
	).Scan(&c.Salt, &c.WrappedDEK, &createdAt, &updatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("failed to get user credential: %w", err)
	}
	c.UserEmail = userEmail
	c.CreatedAt = time.Unix(createdAt, 0).UTC()
	c.UpdatedAt = time.Unix(updatedAt, 0).UTC()
	return &c, nil
}

// CreateUserCredential 建立使用者憑證包
func (s *SQLiteStore) CreateUserCredential(c *UserCredential) error {
	if c.UserEmail == "" || len(c.Salt) == 0 || c.WrappedDEK == "" {
		return errors.New("user_email, salt, and wrapped_dek are required")
	}
	now := time.Now().UTC()
	c.CreatedAt = now
	c.UpdatedAt = now
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.Exec(
		`INSERT INTO users (owner_id, salt, wrapped_dek, pending_encrypt, created_at, updated_at)
		 VALUES (?, ?, ?, 0, ?, ?)`,
		crypto.OwnerID(c.UserEmail), c.Salt, c.WrappedDEK, c.CreatedAt.Unix(), c.UpdatedAt.Unix(),
	)
	if err != nil {
		return fmt.Errorf("failed to create user credential: %w", err)
	}
	return nil
}

// UpdateUserCredential 更新使用者憑證包（改 master password 後 re-wrap DEK）
func (s *SQLiteStore) UpdateUserCredential(c *UserCredential) error {
	if c.UserEmail == "" || len(c.Salt) == 0 || c.WrappedDEK == "" {
		return errors.New("user_email, salt, and wrapped_dek are required")
	}
	c.UpdatedAt = time.Now().UTC()
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.Exec(
		`UPDATE users SET salt = ?, wrapped_dek = ?, updated_at = ? WHERE owner_id = ?`,
		c.Salt, c.WrappedDEK, c.UpdatedAt.Unix(), crypto.OwnerID(c.UserEmail),
	)
	if err != nil {
		return fmt.Errorf("failed to update user credential: %w", err)
	}
	return nil
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

// ===== User Prefs =====

// GetUserPref 取得 per-user key-value（無則回傳 ""）
func (s *SQLiteStore) GetUserPref(userEmail, key string, dek []byte) (string, error) {
	var val string
	err := s.db.QueryRow(`SELECT pref_value FROM user_prefs WHERE owner_id = ? AND pref_key = ?`, crypto.OwnerID(userEmail), key).Scan(&val)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("failed to get user pref %s: %w", key, err)
	}
	return crypto.UnwrapField(dek, val)
}

// SetUserPref upsert per-user key-value
func (s *SQLiteStore) SetUserPref(userEmail, key, value string, dek []byte) error {
	if userEmail == "" || key == "" {
		return errors.New("user_email and key are required")
	}
	enc, err := crypto.WrapField(dek, value)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err = s.db.Exec(
		`INSERT INTO user_prefs (owner_id, pref_key, pref_value, updated_at)
		 VALUES (?, ?, ?, ?)
		 ON CONFLICT(owner_id, pref_key) DO UPDATE SET
			pref_value = excluded.pref_value,
			updated_at = excluded.updated_at`,
		crypto.OwnerID(userEmail), key, enc, time.Now().UTC().Unix(),
	)
	if err != nil {
		return fmt.Errorf("failed to set user pref %s: %w", key, err)
	}
	return nil
}
