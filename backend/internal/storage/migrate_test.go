package storage

import (
	"database/sql"
	"errors"
	"strings"
	"testing"

	"github.com/johnwmail/e2mail/backend/internal/crypto"
	_ "modernc.org/sqlite"
)

// v1Schema 為 v0.5.x（明文鍵/明文內容）之精確 schema
const v1Schema = `
CREATE TABLE contact_keys (
	owner_email    TEXT NOT NULL,
	contact_email  TEXT NOT NULL,
	name           TEXT NOT NULL DEFAULT '',
	fingerprint    TEXT NOT NULL,
	key_id         TEXT NOT NULL DEFAULT '',
	armored_key    TEXT NOT NULL,
	created_at     INTEGER NOT NULL,
	PRIMARY KEY (owner_email, contact_email)
);
CREATE TABLE personal_keyrings (
	owner_email              TEXT NOT NULL PRIMARY KEY,
	public_key_armored       TEXT NOT NULL,
	encrypted_private_key    TEXT NOT NULL,
	fingerprint              TEXT NOT NULL,
	key_id                   TEXT NOT NULL DEFAULT '',
	updated_at               INTEGER NOT NULL
);
CREATE TABLE two_fa (
	owner_email        TEXT NOT NULL PRIMARY KEY,
	secret             TEXT NOT NULL,
	backup_code_hashes TEXT NOT NULL DEFAULT '[]',
	enabled_at         INTEGER NOT NULL
);
CREATE TABLE users (
	owner_email  TEXT NOT NULL PRIMARY KEY,
	salt         BLOB NOT NULL,
	wrapped_dek  TEXT NOT NULL,
	created_at   INTEGER NOT NULL,
	updated_at   INTEGER NOT NULL
);
CREATE TABLE accounts (
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
CREATE TABLE folder_prefs (
	user_email   TEXT NOT NULL,
	account_id   TEXT NOT NULL,
	folder_name  TEXT NOT NULL,
	visible      INTEGER NOT NULL DEFAULT 1,
	PRIMARY KEY (user_email, account_id, folder_name)
);
CREATE TABLE folder_order (
	account_id   TEXT NOT NULL,
	folder_name  TEXT NOT NULL,
	sort_index   INTEGER NOT NULL DEFAULT 0,
	PRIMARY KEY (account_id, folder_name)
);
CREATE TABLE contacts (
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
CREATE TABLE user_prefs (
	owner_email  TEXT NOT NULL,
	pref_key     TEXT NOT NULL,
	pref_value   TEXT NOT NULL DEFAULT '',
	updated_at   INTEGER NOT NULL,
	PRIMARY KEY (owner_email, pref_key)
);
`

func TestMigrateV1toV2(t *testing.T) {
	dir := t.TempDir()
	dbPath := dir + "/e2Mail.db"

	// 1. 建 v1 DB + 數據（含大細寫碰撞、孤兒 folder_order）
	db, err := sql.Open("sqlite", "file:"+dbPath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(v1Schema); err != nil {
		t.Fatalf("v1 schema: %v", err)
	}
	mustExec := func(q string, args ...any) {
		t.Helper()
		if _, err := db.Exec(q, args...); err != nil {
			t.Fatalf("%s: %v", q, err)
		}
	}
	mustExec(`INSERT INTO users (owner_email, salt, wrapped_dek, created_at, updated_at) VALUES ('alice@test.com', 'salt1', 'wd1', 100, 200)`)
	mustExec(`INSERT INTO users (owner_email, salt, wrapped_dek, created_at, updated_at) VALUES ('bob@test.com', 'salt2', 'wd2', 100, 100)`)
	mustExec(`INSERT INTO accounts (id, user_email, label, email, imap_host, imap_port, smtp_host, smtp_port, username, enc_imap_password, enc_smtp_password, is_default, created_at, updated_at)
		VALUES ('acc1', 'alice@test.com', '主信箱', 'alice@test.com', 'mail.test.com', 993, 'smtp.test.com', 587, 'alice@test.com', 'E1', 'E2', 1, 1, 2)`)
	mustExec(`INSERT INTO contacts (id, owner_email, email, display_name, note, source, created_at, updated_at)
		VALUES ('c1', 'alice@test.com', 'friend@x.com', 'Friend', 'note1', 'manual', 1, 1)`)
	// 碰撞：大細寫 email（v1 UNIQUE 唔阻，owner 同 email 變體 → 同一 owner_id+email_hash）
	mustExec(`INSERT INTO contacts (id, owner_email, email, display_name, note, source, created_at, updated_at)
		VALUES ('c2', 'alice@test.com', 'FRIEND@X.COM', 'FriendNew', 'note2', 'manual', 1, 2)`)
	mustExec(`INSERT INTO contact_keys (owner_email, contact_email, name, fingerprint, key_id, armored_key, created_at)
		VALUES ('bob@test.com', 'pk@x.com', 'PK', 'FP', 'KI', 'ARMORED', 5)`)
	mustExec(`INSERT INTO personal_keyrings (owner_email, public_key_armored, encrypted_private_key, fingerprint, key_id, updated_at)
		VALUES ('bob@test.com', 'PUB', 'LEGACY-DEK-B64', 'FPB', 'KIB', 9)`)
	mustExec(`INSERT INTO two_fa (owner_email, secret, backup_code_hashes, enabled_at) VALUES ('bob@test.com', 'SECRET-B64', '["h"]', 7)`)
	mustExec(`INSERT INTO folder_prefs (user_email, account_id, folder_name, visible) VALUES ('alice@test.com', 'acc1', 'Gmail', 0)`)
	mustExec(`INSERT INTO folder_order (account_id, folder_name, sort_index) VALUES ('acc1', 'Gmail', 1)`)
	mustExec(`INSERT INTO folder_order (account_id, folder_name, sort_index) VALUES ('accGONE', 'JobsDB', 0)`) // 孤兒
	mustExec(`INSERT INTO user_prefs (owner_email, pref_key, pref_value, updated_at) VALUES ('alice@test.com', 'listMode', 'threads', 3)`)
	_ = db.Close()

	// 2. 用 NewSQLiteStore 開 → 自動遷移
	s, err := NewSQLiteStore(dir)
	if err != nil {
		t.Fatalf("NewSQLiteStore (migrate): %v", err)
	}
	defer func() { _ = s.Close() }()

	var ver int
	if err := s.db.QueryRow(`PRAGMA user_version`).Scan(&ver); err != nil || ver != 2 {
		t.Fatalf("user_version = %d (%v), want 2", ver, err)
	}

	dek := testDEK()

	// users: hash 鍵 + pending 標記
	uc, err := s.GetUserCredential("Alice@Test.com") // 大細寫變體都要搵到
	if err != nil || uc == nil || uc.WrappedDEK != "wd1" {
		t.Fatalf("user credential lost: %+v %v", uc, err)
	}
	if pending, _ := s.HasPendingEncrypt("alice@test.com"); !pending {
		t.Fatal("migrated owner must be pending")
	}
	rawOwner := rawCol(t, s, `SELECT owner_id FROM users WHERE owner_id = (SELECT owner_id FROM users LIMIT 1)`)
	if strings.Contains(rawOwner, "@") {
		t.Fatalf("owner_id not hashed: %s", rawOwner)
	}

	// accounts 內容可读 + DB 無明文
	acc, err := s.GetAccount("alice@test.com", "acc1", dek)
	if err != nil || acc == nil || acc.Email != "alice@test.com" || acc.IMAPHost != "mail.test.com" || acc.Username != "alice@test.com" || acc.EncIMAPPassword != "E1" {
		t.Fatalf("migrated account: %+v %v", acc, err)
	}
	if rawCol(t, s, `SELECT label FROM accounts WHERE id='acc1'`) == "主信箱" {
		t.Fatal("migrated label still plaintext")
	}

	// contacts 碰撞合併（保最新 updated_at：c2 'FriendNew'）
	cl, err := s.ListAddressContacts("alice@test.com", "", 0, 0, dek)
	if err != nil || len(cl) != 1 || cl[0].DisplayName != "FriendNew" {
		t.Fatalf("collision merge: %+v %v", cl, err)
	}

	// contact_keys / keyring / two_fa / prefs 遷移
	ck, err := s.GetContact("bob@test.com", "pk@x.com", nil) // pending 欄可讀（未 lazy 前）
	if err != nil || ck == nil || ck.ArmoredKey != "ARMORED" {
		t.Fatalf("contact_keys migrate: %+v %v", ck, err)
	}
	kr, err := s.GetKeyring("bob@test.com", nil)
	if err != nil || kr == nil || kr.EncryptedPrivateKeyArmored != "LEGACY-DEK-B64" || kr.PublicKeyArmored != "PUB" {
		t.Fatalf("keyring migrate: %+v %v", kr, err)
	}
	tf, err := s.GetTwoFA("bob@test.com")
	if err != nil || tf == nil || tf.Secret != "SECRET-B64" {
		t.Fatalf("two_fa migrate: %+v %v", tf, err)
	}
	v, err := s.GetUserPref("alice@test.com", "listMode", nil)
	if err != nil || v != "threads" {
		t.Fatalf("user_pref migrate: %q %v", v, err)
	}
	// folder prefs/order 遷移（pending 讀）
	fp, err := s.ListFolderPrefs("alice@test.com", "acc1", nil)
	if err != nil || fp["Gmail"] != false {
		t.Fatalf("folder_prefs migrate: %v %v", fp, err)
	}
	fo, err := s.GetFolderOrder("alice@test.com", "acc1", nil)
	if err != nil || len(fo) != 1 || fo[0] != "Gmail" {
		t.Fatalf("folder_order migrate: %v %v", fo, err)
	}
	// 孤兒 folder_order 丟棄
	var orphan int
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM folder_order WHERE account_id='accGONE'`).Scan(&orphan); err != nil || orphan != 0 {
		t.Fatalf("orphan folder_order rows = %d", orphan)
	}
	// folder_order 帶 owner
	var foOwner string
	if err := s.db.QueryRow(`SELECT owner_id FROM folder_order WHERE account_id='acc1'`).Scan(&foOwner); err != nil || foOwner != crypto.OwnerID("alice@test.com") {
		t.Fatalf("folder_order owner mapping: %q %v", foOwner, err)
	}

	// 3. lazy 轉換
	n, err := s.EncryptPendingFields("alice@test.com", dek)
	if err != nil || n == 0 {
		t.Fatalf("lazy alice: %d %v", n, err)
	}
	n2, err := s.EncryptPendingFields("bob@test.com", dek)
	if err != nil || n2 == 0 {
		t.Fatalf("lazy bob: %d %v", n2, err)
	}
	if cnt, _ := s.CountPendingFields(); cnt != 0 {
		t.Fatalf("residual pending after full lazy: %d", cnt)
	}
	if _, err := s.GetAccount("alice@test.com", "acc1", dek); err != nil {
		t.Fatalf("post-lazy read: %v", err)
	}

	// 4. 舊 DB 檔重開冪等（唔再遷移）
	_ = s.Close()
	s2, err := NewSQLiteStore(dir)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer func() { _ = s2.Close() }()
	if _, err := s2.GetAccount("alice@test.com", "acc1", dek); err != nil {
		t.Fatalf("reopen read: %v", err)
	}
}

func TestMigrateRollbackOnFailure(t *testing.T) {
	dir := t.TempDir()
	dbPath := dir + "/e2Mail.db"
	db, err := sql.Open("sqlite", "file:"+dbPath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(v1Schema); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO contacts (id, owner_email, email, display_name, note, source, created_at, updated_at) VALUES ('c1', 'a@x.com', 'a@b.c', 'A', '', 'manual', 1, 1)`); err != nil {
		t.Fatal(err)
	}
	// 注入「事務內提交前失敗」→ 驗證 ROLLBACK：schema 同數據停留 v1
	err = migrateV1toV2WithHook(db, func() error { return errors.New("injected failure") })
	if err == nil {
		t.Fatal("expected injected migration failure")
	}
	var cnt int
	if err := db.QueryRow(`SELECT COUNT(*) FROM pragma_table_info('contacts') WHERE name='owner_email'`).Scan(&cnt); err != nil || cnt == 0 {
		t.Fatalf("rollback did not preserve v1 schema: %v %d", err, cnt)
	}
	var ver int
	_ = db.QueryRow(`PRAGMA user_version`).Scan(&ver)
	if ver == 2 {
		t.Fatal("user_version bumped despite failed migration")
	}
	if err := db.QueryRow(`SELECT COUNT(*) FROM contacts`).Scan(&cnt); err != nil || cnt != 1 {
		t.Fatalf("data lost after rollback: %d %v", cnt, err)
	}
	_ = db.Close()

	// 正常路徑都同時覆蓋：無 hook → 成功
	s, err := NewSQLiteStore(dir)
	if err != nil {
		t.Fatalf("clean migration after rollback: %v", err)
	}
	_ = s.Close()
}
