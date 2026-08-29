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

	"github.com/google/uuid"
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

// Account 儲存於 SQLite 之郵件帳號設定（密碼以 DEK 加密，非明文）
type Account struct {
	ID                  string    `json:"id"`
	UserEmail           string    `json:"-"` // 登入者（owner）
	Label               string    `json:"label"`
	Email               string    `json:"email"`
	IMAPHost            string    `json:"imapHost"`
	IMAPPort            int       `json:"imapPort"`
	IMAPUseTLS          bool      `json:"imapUseTls"`
	IMAPAllowInsecureTLS bool     `json:"imapAllowInsecureTls"`
	SMTPHost            string    `json:"smtpHost"`
	SMTPPort            int       `json:"smtpPort"`
	SMTPUseTLS          bool      `json:"smtpUseTls"`
	SMTPAllowInsecureTLS bool     `json:"smtpAllowInsecureTls"`
	Username            string    `json:"username"`
	EncIMAPPassword     string    `json:"-"` // AES-GCM(DEK, imap_password)
	EncSMTPPassword     string    `json:"-"` // AES-GCM(DEK, smtp_password)
	IsDefault           bool      `json:"isDefault"`
	SortOrder           int       `json:"sortOrder"`
	CreatedAt           time.Time `json:"createdAt"`
	UpdatedAt           time.Time `json:"updatedAt"`
}

// UserCredential 儲存於 SQLite 之 per-user 憑證包（包裹 DEK）
type UserCredential struct {
	UserEmail  string    `json:"userEmail"`
	Salt       []byte    `json:"salt"`
	WrappedDEK string    `json:"wrappedDek"` // AES-GCM(MasterKey, DEK)
	CreatedAt  time.Time `json:"createdAt"`
	UpdatedAt  time.Time `json:"updatedAt"`
}

// Contact 通訊錄聯絡人（通用地址簿，非 PGP 專用）
type Contact struct {
	ID          string    `json:"id"`
	OwnerEmail  string    `json:"-"`
	Email       string    `json:"email"`
	DisplayName string    `json:"displayName"`
	GivenName   string    `json:"givenName"`
	FamilyName  string    `json:"familyName"`
	AvatarPath  string    `json:"-"`
	HasAvatar   bool      `json:"hasAvatar"`
	Note        string    `json:"note"`
	Source      string    `json:"source"`
	CreatedAt   time.Time `json:"createdAt"`
	UpdatedAt   time.Time `json:"updatedAt"`
}

// Store SQLite 儲存介面
type Store interface {
	// Contacts (PGP 公鑰)
	ListContacts(ownerEmail string) ([]ContactKey, error)
	GetContact(ownerEmail, contactEmail string) (*ContactKey, error)
	UpsertContact(contact ContactKey) error
	BulkUpsertContacts(ownerEmail string, contacts []ContactKey) (saved int, skipped []string, err error)
	DeleteContact(ownerEmail, contactEmail string) (int64, error)

	// Address book (通用通訊錄)
	ListAddressContacts(ownerEmail string, query string, limit, offset int) ([]Contact, error)
	GetAddressContact(ownerEmail, id string) (*Contact, error)
	GetAddressContactByEmail(ownerEmail, email string) (*Contact, error)
	CreateAddressContact(c *Contact) error
	UpdateAddressContact(c *Contact) error
	DeleteAddressContact(ownerEmail, id string) (int64, error)
	CountAddressContacts(ownerEmail string) (int, error)
	ResolveAddressContacts(ownerEmail string, emails []string) (map[string]*Contact, error)

	// Personal keyring
	GetKeyring(ownerEmail string) (*Keyring, error)
	SaveKeyring(keyring *Keyring) error
	DeleteKeyring(ownerEmail string) error

	// Two-factor authentication
	GetTwoFA(ownerEmail string) (*TwoFA, error)
	SaveTwoFA(t *TwoFA) error
	DeleteTwoFA(ownerEmail string) error

	// Accounts (multi-account registry, per-user)
	ListAccounts(userEmail string) ([]Account, error)
	GetAccount(userEmail, accountID string) (*Account, error)
	CreateAccount(acc *Account) error
	UpdateAccount(acc *Account) error
	DeleteAccount(userEmail, accountID string) error
	SetDefaultAccount(userEmail, accountID string) error
	CountAccounts(userEmail string) (int, error)

	// User credentials (wrapped DEK per user)
	GetUserCredential(userEmail string) (*UserCredential, error)
	CreateUserCredential(cred *UserCredential) error
	UpdateUserCredential(cred *UserCredential) error

	// Folder display prefs (WebMail-only, per account; not IMAP subscription)
	ListFolderPrefs(userEmail, accountID string) (map[string]bool, error)
	SetFolderPref(userEmail, accountID, folderName string, visible bool) error

	// Folder order (top-level folder display order, per account)
	GetFolderOrder(userEmail, accountID string) ([]string, error)
	SetFolderOrder(userEmail, accountID string, orderedNames []string) error

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

CREATE TABLE IF NOT EXISTS users (
	owner_email  TEXT NOT NULL PRIMARY KEY,
	salt         BLOB NOT NULL,
	wrapped_dek  TEXT NOT NULL,
	created_at   INTEGER NOT NULL,
	updated_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS accounts (
	id                     TEXT NOT NULL PRIMARY KEY,
	user_email             TEXT NOT NULL,
	label                  TEXT NOT NULL,
	email                  TEXT NOT NULL,
	imap_host              TEXT NOT NULL,
	imap_port              INTEGER NOT NULL,
	imap_use_tls           INTEGER NOT NULL DEFAULT 1,
	imap_allow_insecure_tls INTEGER NOT NULL DEFAULT 0,
	smtp_host              TEXT NOT NULL,
	smtp_port              INTEGER NOT NULL,
	smtp_use_tls           INTEGER NOT NULL DEFAULT 1,
	smtp_allow_insecure_tls INTEGER NOT NULL DEFAULT 0,
	username               TEXT NOT NULL,
	enc_imap_password      TEXT NOT NULL,
	enc_smtp_password      TEXT NOT NULL,
	is_default             INTEGER NOT NULL DEFAULT 0,
	sort_order             INTEGER NOT NULL DEFAULT 0,
	created_at             INTEGER NOT NULL,
	updated_at             INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_accounts_user ON accounts(user_email);

CREATE TABLE IF NOT EXISTS folder_prefs (
	user_email   TEXT NOT NULL,
	account_id   TEXT NOT NULL,
	folder_name  TEXT NOT NULL,
	visible      INTEGER NOT NULL DEFAULT 1,
	PRIMARY KEY (user_email, account_id, folder_name)
);
CREATE INDEX IF NOT EXISTS idx_folder_prefs_account ON folder_prefs(account_id);

CREATE TABLE IF NOT EXISTS folder_order (
	account_id   TEXT NOT NULL,
	folder_name  TEXT NOT NULL,
	sort_index   INTEGER NOT NULL DEFAULT 0,
	PRIMARY KEY (account_id, folder_name)
);
CREATE INDEX IF NOT EXISTS idx_folder_order_account ON folder_order(account_id);

CREATE TABLE IF NOT EXISTS contacts (
	id            TEXT NOT NULL PRIMARY KEY,
	owner_email   TEXT NOT NULL,
	email         TEXT NOT NULL,
	display_name  TEXT NOT NULL DEFAULT '',
	given_name    TEXT NOT NULL DEFAULT '',
	family_name   TEXT NOT NULL DEFAULT '',
	avatar_path   TEXT NOT NULL DEFAULT '',
	note          TEXT NOT NULL DEFAULT '',
	source        TEXT NOT NULL DEFAULT 'manual',
	created_at    INTEGER NOT NULL,
	updated_at    INTEGER NOT NULL,
	UNIQUE(owner_email, email)
);
CREATE INDEX IF NOT EXISTS idx_contacts_owner ON contacts(owner_email);
CREATE INDEX IF NOT EXISTS idx_contacts_owner_email ON contacts(owner_email, email);
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
	defer func() { _ = rows.Close() }()

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
func (s *SQLiteStore) DeleteContact(ownerEmail, contactEmail string) (int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	res, err := s.db.Exec(
		`DELETE FROM contact_keys WHERE owner_email = ? AND contact_email = ?`,
		ownerEmail, contactEmail,
	)
	if err != nil {
		return 0, fmt.Errorf("failed to delete contact: %w", err)
	}
	return res.RowsAffected()
}

// ===== Address book (通用通訊錄) =====

func scanContact(row interface{ Scan(...any) error }) (*Contact, error) {
	var c Contact
	var createdAt, updatedAt int64
	err := row.Scan(&c.ID, &c.OwnerEmail, &c.Email, &c.DisplayName, &c.GivenName, &c.FamilyName, &c.AvatarPath, &c.Note, &c.Source, &createdAt, &updatedAt)
	if err != nil {
		return nil, err
	}
	c.HasAvatar = c.AvatarPath != ""
	c.CreatedAt = time.Unix(createdAt, 0).UTC()
	c.UpdatedAt = time.Unix(updatedAt, 0).UTC()
	return &c, nil
}

// ListAddressContacts 列出通訊錄（支援 q 關鍵字搜尋 email/displayName，limit/offset 分頁，0 表示不限）
func (s *SQLiteStore) ListAddressContacts(ownerEmail string, query string, limit, offset int) ([]Contact, error) {
	q := strings.TrimSpace(query)
	var rows *sql.Rows
	var err error
	if q == "" {
		if limit > 0 {
			rows, err = s.db.Query(`SELECT id, owner_email, email, display_name, given_name, family_name, avatar_path, note, source, created_at, updated_at FROM contacts WHERE owner_email = ? ORDER BY display_name ASC, email ASC LIMIT ? OFFSET ?`, ownerEmail, limit, offset)
		} else {
			rows, err = s.db.Query(`SELECT id, owner_email, email, display_name, given_name, family_name, avatar_path, note, source, created_at, updated_at FROM contacts WHERE owner_email = ? ORDER BY display_name ASC, email ASC`, ownerEmail)
		}
	} else {
		like := "%" + q + "%"
		if limit > 0 {
			rows, err = s.db.Query(`SELECT id, owner_email, email, display_name, given_name, family_name, avatar_path, note, source, created_at, updated_at FROM contacts WHERE owner_email = ? AND (email LIKE ? OR display_name LIKE ? OR note LIKE ?) ORDER BY display_name ASC, email ASC LIMIT ? OFFSET ?`, ownerEmail, like, like, like, limit, offset)
		} else {
			rows, err = s.db.Query(`SELECT id, owner_email, email, display_name, given_name, family_name, avatar_path, note, source, created_at, updated_at FROM contacts WHERE owner_email = ? AND (email LIKE ? OR display_name LIKE ? OR note LIKE ?) ORDER BY display_name ASC, email ASC`, ownerEmail, like, like, like)
		}
	}
	if err != nil {
		return nil, fmt.Errorf("failed to list contacts: %w", err)
	}
	defer func() { _ = rows.Close() }()
	out := make([]Contact, 0)
	for rows.Next() {
		c, err := scanContact(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *c)
	}
	return out, rows.Err()
}

// GetAddressContact 以 id 取得單一聯絡人
func (s *SQLiteStore) GetAddressContact(ownerEmail, id string) (*Contact, error) {
	row := s.db.QueryRow(`SELECT id, owner_email, email, display_name, given_name, family_name, avatar_path, note, source, created_at, updated_at FROM contacts WHERE owner_email = ? AND id = ?`, ownerEmail, id)
	c, err := scanContact(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("failed to get contact: %w", err)
	}
	return c, nil
}

// GetAddressContactByEmail 以 email 取得單一聯絡人
func (s *SQLiteStore) GetAddressContactByEmail(ownerEmail, email string) (*Contact, error) {
	email = strings.ToLower(strings.TrimSpace(email))
	row := s.db.QueryRow(`SELECT id, owner_email, email, display_name, given_name, family_name, avatar_path, note, source, created_at, updated_at FROM contacts WHERE owner_email = ? AND email = ?`, ownerEmail, email)
	c, err := scanContact(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("failed to get contact by email: %w", err)
	}
	return c, nil
}

// CreateAddressContact 新增聯絡人
func (s *SQLiteStore) CreateAddressContact(c *Contact) error {
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
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.Exec(`INSERT INTO contacts (id, owner_email, email, display_name, given_name, family_name, avatar_path, note, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, c.ID, c.OwnerEmail, c.Email, c.DisplayName, c.GivenName, c.FamilyName, c.AvatarPath, c.Note, c.Source, c.CreatedAt.Unix(), c.UpdatedAt.Unix())
	if err != nil {
		return fmt.Errorf("failed to create contact: %w", err)
	}
	c.HasAvatar = c.AvatarPath != ""
	return nil
}

// UpdateAddressContact 更新聯絡人（以 id + owner 為鍵）
func (s *SQLiteStore) UpdateAddressContact(c *Contact) error {
	if c.ID == "" || c.OwnerEmail == "" {
		return errors.New("id and owner_email are required")
	}
	c.Email = strings.ToLower(strings.TrimSpace(c.Email))
	c.UpdatedAt = time.Now().UTC()
	s.mu.Lock()
	defer s.mu.Unlock()
	res, err := s.db.Exec(`UPDATE contacts SET email = ?, display_name = ?, given_name = ?, family_name = ?, avatar_path = ?, note = ?, source = ?, updated_at = ? WHERE owner_email = ? AND id = ?`, c.Email, c.DisplayName, c.GivenName, c.FamilyName, c.AvatarPath, c.Note, c.Source, c.UpdatedAt.Unix(), c.OwnerEmail, c.ID)
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
	res, err := s.db.Exec(`DELETE FROM contacts WHERE owner_email = ? AND id = ?`, ownerEmail, id)
	if err != nil {
		return 0, fmt.Errorf("failed to delete contact: %w", err)
	}
	return res.RowsAffected()
}

// CountAddressContacts 計算聯絡人數
func (s *SQLiteStore) CountAddressContacts(ownerEmail string) (int, error) {
	var n int
	err := s.db.QueryRow(`SELECT COUNT(*) FROM contacts WHERE owner_email = ?`, ownerEmail).Scan(&n)
	if err != nil {
		return 0, fmt.Errorf("failed to count contacts: %w", err)
	}
	return n, nil
}

// ResolveAddressContacts 批量以 email 解析聯絡人（最多 100）
func (s *SQLiteStore) ResolveAddressContacts(ownerEmail string, emails []string) (map[string]*Contact, error) {
	if len(emails) == 0 {
		return map[string]*Contact{}, nil
	}
	// 正規化並去重
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
	placeholders := strings.Repeat("?,", len(normed))
	placeholders = placeholders[:len(placeholders)-1]
	args := make([]any, 0, len(normed)+1)
	args = append(args, ownerEmail)
	for _, e := range normed {
		args = append(args, e)
	}
	q := fmt.Sprintf(`SELECT id, owner_email, email, display_name, given_name, family_name, avatar_path, note, source, created_at, updated_at FROM contacts WHERE owner_email = ? AND email IN (%s)`, placeholders)
	rows, err := s.db.Query(q, args...)
	if err != nil {
		return nil, fmt.Errorf("failed to resolve contacts: %w", err)
	}
	defer func() { _ = rows.Close() }()
	out := make(map[string]*Contact)
	for rows.Next() {
		c, err := scanContact(rows)
		if err != nil {
			return nil, err
		}
		out[c.Email] = c
	}
	return out, rows.Err()
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

// ===== Folder display prefs (WebMail-only) =====

// ListFolderPrefs 返回帳號各 folder 嘅顯示偏好（visible map）；無記錄嘅 folder 唔喺 map 入面（視作 default）
func (s *SQLiteStore) ListFolderPrefs(userEmail, accountID string) (map[string]bool, error) {
	rows, err := s.db.Query(
		`SELECT folder_name, visible FROM folder_prefs WHERE user_email = ? AND account_id = ?`,
		userEmail, accountID,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to list folder prefs: %w", err)
	}
	defer func() { _ = rows.Close() }()
	out := make(map[string]bool)
	for rows.Next() {
		var name string
		var visible int
		if err := rows.Scan(&name, &visible); err != nil {
			return nil, err
		}
		out[name] = visible == 1
	}
	return out, rows.Err()
}

// SetFolderPref 設定單一 folder 嘅顯示偏好（upsert）
func (s *SQLiteStore) SetFolderPref(userEmail, accountID, folderName string, visible bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.Exec(
		`INSERT INTO folder_prefs (user_email, account_id, folder_name, visible)
		 VALUES (?, ?, ?, ?)
		 ON CONFLICT(user_email, account_id, folder_name) DO UPDATE SET visible = excluded.visible`,
		userEmail, accountID, folderName, boolInt(visible),
	)
	if err != nil {
		return fmt.Errorf("failed to set folder pref: %w", err)
	}
	return nil
}

// GetFolderOrder 返回帳號頂層 folder 顯示次序（按 sort_index 排序）；無記錄則空
func (s *SQLiteStore) GetFolderOrder(userEmail, accountID string) ([]string, error) {
	rows, err := s.db.Query(
		`SELECT folder_name FROM folder_order
		 WHERE account_id = ? ORDER BY sort_index ASC`,
		accountID,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to get folder order: %w", err)
	}
	defer func() { _ = rows.Close() }()
	var out []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, err
		}
		out = append(out, name)
	}
	return out, rows.Err()
}

// SetFolderOrder 重寫帳號頂層 folder 顯示次序（先刪後插）
func (s *SQLiteStore) SetFolderOrder(userEmail, accountID string, orderedNames []string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("failed to begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.Exec(`DELETE FROM folder_order WHERE account_id = ?`, accountID); err != nil {
		return err
	}
	for i, name := range orderedNames {
		if _, err := tx.Exec(
			`INSERT INTO folder_order (account_id, folder_name, sort_index) VALUES (?, ?, ?)`,
			accountID, name, i,
		); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// ===== Accounts =====

func scanAccount(rows interface{ Scan(...any) error }) (*Account, error) {
	var a Account
	var imapUseTLS, imapInsecure, smtpUseTLS, smtpInsecure, isDefault int
	var createdAt, updatedAt int64
	err := rows.Scan(
		&a.ID, &a.UserEmail, &a.Label, &a.Email,
		&a.IMAPHost, &a.IMAPPort, &imapUseTLS, &imapInsecure,
		&a.SMTPHost, &a.SMTPPort, &smtpUseTLS, &smtpInsecure,
		&a.Username, &a.EncIMAPPassword, &a.EncSMTPPassword,
		&isDefault, &a.SortOrder, &createdAt, &updatedAt,
	)
	if err != nil {
		return nil, err
	}
	a.IMAPUseTLS = imapUseTLS == 1
	a.IMAPAllowInsecureTLS = imapInsecure == 1
	a.SMTPUseTLS = smtpUseTLS == 1
	a.SMTPAllowInsecureTLS = smtpInsecure == 1
	a.IsDefault = isDefault == 1
	a.CreatedAt = time.Unix(createdAt, 0).UTC()
	a.UpdatedAt = time.Unix(updatedAt, 0).UTC()
	return &a, nil
}

// ListAccounts 列出某使用者所有帳號（依 sort_order）
func (s *SQLiteStore) ListAccounts(userEmail string) ([]Account, error) {
	rows, err := s.db.Query(
		`SELECT id, user_email, label, email,
		        imap_host, imap_port, imap_use_tls, imap_allow_insecure_tls,
		        smtp_host, smtp_port, smtp_use_tls, smtp_allow_insecure_tls,
		        username, enc_imap_password, enc_smtp_password,
		        is_default, sort_order, created_at, updated_at
		 FROM accounts WHERE user_email = ? ORDER BY sort_order ASC, created_at ASC`,
		userEmail,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to list accounts: %w", err)
	}
	defer func() { _ = rows.Close() }()

	out := make([]Account, 0)
	for rows.Next() {
		a, err := scanAccount(rows)
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
func (s *SQLiteStore) GetAccount(userEmail, accountID string) (*Account, error) {
	row := s.db.QueryRow(
		`SELECT id, user_email, label, email,
		        imap_host, imap_port, imap_use_tls, imap_allow_insecure_tls,
		        smtp_host, smtp_port, smtp_use_tls, smtp_allow_insecure_tls,
		        username, enc_imap_password, enc_smtp_password,
		        is_default, sort_order, created_at, updated_at
		 FROM accounts WHERE user_email = ? AND id = ?`,
		userEmail, accountID,
	)
	a, err := scanAccount(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("failed to get account: %w", err)
	}
	return a, nil
}

// CreateAccount 建立新帳號
func (s *SQLiteStore) CreateAccount(a *Account) error {
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

	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.Exec(
		`INSERT INTO accounts (id, user_email, label, email,
		        imap_host, imap_port, imap_use_tls, imap_allow_insecure_tls,
		        smtp_host, smtp_port, smtp_use_tls, smtp_allow_insecure_tls,
		        username, enc_imap_password, enc_smtp_password,
		        is_default, sort_order, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		a.ID, a.UserEmail, a.Label, a.Email,
		a.IMAPHost, a.IMAPPort, boolInt(a.IMAPUseTLS), boolInt(a.IMAPAllowInsecureTLS),
		a.SMTPHost, a.SMTPPort, boolInt(a.SMTPUseTLS), boolInt(a.SMTPAllowInsecureTLS),
		a.Username, a.EncIMAPPassword, a.EncSMTPPassword,
		boolInt(a.IsDefault), a.SortOrder, a.CreatedAt.Unix(), a.UpdatedAt.Unix(),
	)
	if err != nil {
		return fmt.Errorf("failed to create account: %w", err)
	}
	return nil
}

// UpdateAccount 更新帳號（不含密碼欄位時保留原值，由 caller 決定）
func (s *SQLiteStore) UpdateAccount(a *Account) error {
	if a.ID == "" {
		return errors.New("account id is required")
	}
	a.UpdatedAt = time.Now().UTC()
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.Exec(
		`UPDATE accounts SET
		        label = ?, email = ?,
		        imap_host = ?, imap_port = ?, imap_use_tls = ?, imap_allow_insecure_tls = ?,
		        smtp_host = ?, smtp_port = ?, smtp_use_tls = ?, smtp_allow_insecure_tls = ?,
		        username = ?, enc_imap_password = ?, enc_smtp_password = ?,
		        is_default = ?, sort_order = ?, updated_at = ?
		 WHERE user_email = ? AND id = ?`,
		a.Label, a.Email,
		a.IMAPHost, a.IMAPPort, boolInt(a.IMAPUseTLS), boolInt(a.IMAPAllowInsecureTLS),
		a.SMTPHost, a.SMTPPort, boolInt(a.SMTPUseTLS), boolInt(a.SMTPAllowInsecureTLS),
		a.Username, a.EncIMAPPassword, a.EncSMTPPassword,
		boolInt(a.IsDefault), a.SortOrder, a.UpdatedAt.Unix(),
		a.UserEmail, a.ID,
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
	_, err := s.db.Exec(`DELETE FROM accounts WHERE user_email = ? AND id = ?`, userEmail, accountID)
	if err != nil {
		return fmt.Errorf("failed to delete account: %w", err)
	}
	return nil
}

// SetDefaultAccount 將指定帳號設為預設（先清其他，再設目標）
func (s *SQLiteStore) SetDefaultAccount(userEmail, accountID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.Exec(`UPDATE accounts SET is_default = 0 WHERE user_email = ?`, userEmail)
	if err != nil {
		return fmt.Errorf("failed to clear defaults: %w", err)
	}
	res, err := s.db.Exec(
		`UPDATE accounts SET is_default = 1, updated_at = ? WHERE user_email = ? AND id = ?`,
		time.Now().UTC().Unix(), userEmail, accountID,
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
	err := s.db.QueryRow(`SELECT COUNT(*) FROM accounts WHERE user_email = ?`, userEmail).Scan(&n)
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
		`SELECT owner_email, salt, wrapped_dek, created_at, updated_at FROM users WHERE owner_email = ?`,
		userEmail,
	).Scan(&c.UserEmail, &c.Salt, &c.WrappedDEK, &createdAt, &updatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("failed to get user credential: %w", err)
	}
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
		`INSERT INTO users (owner_email, salt, wrapped_dek, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?)`,
		c.UserEmail, c.Salt, c.WrappedDEK, c.CreatedAt.Unix(), c.UpdatedAt.Unix(),
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
		`UPDATE users SET salt = ?, wrapped_dek = ?, updated_at = ? WHERE owner_email = ?`,
		c.Salt, c.WrappedDEK, c.UpdatedAt.Unix(), c.UserEmail,
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
