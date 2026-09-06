package storage

import (
	"strings"
	"testing"

	"github.com/johnwmail/e2mail/backend/internal/crypto"
)

func testDEK() []byte {
	dek := make([]byte, 32)
	copy(dek, []byte("0123456789abcdef0123456789abcdef"))
	return dek
}

// rawCol 直读 DB 列（绕过 unwrap，驗證密文落盤）
func rawCol(t *testing.T, s *SQLiteStore, q string) string {
	t.Helper()
	var v string
	if err := s.db.QueryRow(q).Scan(&v); err != nil {
		t.Fatalf("rawCol %s: %v", q, err)
	}
	return v
}

func newTestStore(t *testing.T) *SQLiteStore {
	t.Helper()
	s, err := NewSQLiteStore(t.TempDir())
	if err != nil {
		t.Fatalf("NewSQLiteStore: %v", err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s
}

func TestTwoFACRUD(t *testing.T) {
	s := newTestStore(t)

	got, err := s.GetTwoFA("a@b.c")
	if err != nil {
		t.Fatalf("GetTwoFA(missing): %v", err)
	}
	if got != nil {
		t.Fatalf("expected nil for missing 2FA, got %+v", got)
	}

	tf := &TwoFA{OwnerEmail: "a@b.c", Secret: "SECRET1", BackupHashes: []string{"h1", "h2"}}
	if err := s.SaveTwoFA(tf); err != nil {
		t.Fatalf("SaveTwoFA: %v", err)
	}

	got, err = s.GetTwoFA("a@b.c")
	if err != nil {
		t.Fatalf("GetTwoFA: %v", err)
	}
	if got.Secret != "SECRET1" {
		t.Fatalf("secret = %q, want SECRET1", got.Secret)
	}
	if len(got.BackupHashes) != 2 {
		t.Fatalf("backup hashes len = %d, want 2", len(got.BackupHashes))
	}
	if got.EnabledAt.IsZero() {
		t.Fatal("EnabledAt should be set")
	}

	// upsert 覆蓋
	tf.Secret = "SECRET2"
	tf.BackupHashes = []string{}
	if err := s.SaveTwoFA(tf); err != nil {
		t.Fatalf("SaveTwoFA upsert: %v", err)
	}
	got, _ = s.GetTwoFA("a@b.c")
	if got.Secret != "SECRET2" {
		t.Fatalf("secret = %q, want SECRET2", got.Secret)
	}
	if got.BackupHashes == nil || len(got.BackupHashes) != 0 {
		t.Fatalf("expected empty non-nil backup hashes, got %#v", got.BackupHashes)
	}

	// 大細寫 email 映射同一 owner
	if got, _ := s.GetTwoFA("A@B.C"); got == nil || got.Secret != "SECRET2" {
		t.Fatal("case-variant email must hit same owner_id")
	}

	if err := s.DeleteTwoFA("a@b.c"); err != nil {
		t.Fatalf("DeleteTwoFA: %v", err)
	}
	if got, _ := s.GetTwoFA("a@b.c"); got != nil {
		t.Fatal("expected nil after DeleteTwoFA")
	}
}

func TestTwoFARequiredFields(t *testing.T) {
	s := newTestStore(t)
	if err := s.SaveTwoFA(&TwoFA{Secret: "SECRET"}); err == nil {
		t.Fatal("expected error when OwnerEmail missing")
	}
	if err := s.SaveTwoFA(&TwoFA{OwnerEmail: "a@b.c"}); err == nil {
		t.Fatal("expected error when Secret missing")
	}
}

func TestContactsCRUD(t *testing.T) {
	s := newTestStore(t)
	dek := testDEK()
	owner := "me@a.b"

	c := ContactKey{
		OwnerEmail:   owner,
		ContactEmail: "them@a.b",
		Name:         "Them",
		Fingerprint:  "FP1",
		KeyID:        "KID1",
		ArmoredKey:   "PUBKEY",
	}
	if err := s.UpsertContact(c, dek); err != nil {
		t.Fatalf("UpsertContact: %v", err)
	}

	// DB 層必須係 e1: 密文，冇明文洩漏
	raw := rawCol(t, s, `SELECT armored_key || '|' || name || '|' || contact_email FROM contact_keys`)
	if !strings.HasPrefix(raw, "e1:") || strings.Contains(raw, "PUBKEY") || strings.Contains(raw, "Them") || strings.Contains(raw, "them@a.b") {
		t.Fatalf("contact columns not encrypted: %s", raw)
	}
	rawEmailHash := rawCol(t, s, `SELECT owner_id || '|' || email_hash FROM contact_keys`)
	if strings.Contains(rawEmailHash, "me@a.b") || strings.Contains(rawEmailHash, "them@a.b") {
		t.Fatalf("contact_keys stores plaintext email: %s", rawEmailHash)
	}

	got, err := s.GetContact(owner, "them@a.b", dek)
	if err != nil {
		t.Fatalf("GetContact: %v", err)
	}
	if got == nil || got.Name != "Them" || got.Fingerprint != "FP1" {
		t.Fatalf("unexpected contact: %+v", got)
	}

	missing, err := s.GetContact(owner, "nobody@a.b", dek)
	if err != nil || missing != nil {
		t.Fatalf("expected (nil, nil) for missing contact, got %+v, %v", missing, err)
	}

	// upsert 更新
	c.Name = "Renamed"
	c.Fingerprint = "FP2"
	if err := s.UpsertContact(c, dek); err != nil {
		t.Fatalf("UpsertContact update: %v", err)
	}
	got, _ = s.GetContact(owner, "them@a.b", dek)
	if got.Name != "Renamed" || got.Fingerprint != "FP2" {
		t.Fatalf("contact not updated: %+v", got)
	}

	list, err := s.ListContacts(owner, dek)
	if err != nil {
		t.Fatalf("ListContacts: %v", err)
	}
	if len(list) != 1 {
		t.Fatalf("list len = %d, want 1", len(list))
	}

	if affected, err := s.DeleteContact(owner, "them@a.b"); err != nil {
		t.Fatalf("DeleteContact: %v", err)
	} else if affected != 1 {
		t.Fatalf("DeleteContact affected = %d, want 1", affected)
	}
	if missing, _ := s.GetContact(owner, "them@a.b", dek); missing != nil {
		t.Fatal("contact should be gone after delete")
	}
}

func TestContactsScopedByOwner(t *testing.T) {
	s := newTestStore(t)
	dek := testDEK()
	c := ContactKey{OwnerEmail: "me@a.b", ContactEmail: "x@y.z", Fingerprint: "F", ArmoredKey: "K"}
	if err := s.UpsertContact(c, dek); err != nil {
		t.Fatalf("UpsertContact: %v", err)
	}
	if got, _ := s.GetContact("other@a.b", "x@y.z", dek); got != nil {
		t.Fatal("contact must not leak across owners")
	}
}

func TestUpsertContactValidation(t *testing.T) {
	s := newTestStore(t)
	dek := testDEK()
	c := ContactKey{OwnerEmail: "me@a.b", ContactEmail: "", Fingerprint: "F", ArmoredKey: "K"}
	if err := s.UpsertContact(c, dek); err == nil {
		t.Fatal("expected error when contact email missing")
	}
	c.ContactEmail = "x@y.z"
	c.Fingerprint = ""
	if err := s.UpsertContact(c, dek); err == nil {
		t.Fatal("expected error when fingerprint missing")
	}
}

func TestBulkUpsertContacts(t *testing.T) {
	s := newTestStore(t)
	dek := testDEK()
	owner := "me@a.b"
	contacts := []ContactKey{
		{OwnerEmail: owner, ContactEmail: "a@x.y", Name: "A", Fingerprint: "FA", ArmoredKey: "KA"},
		{OwnerEmail: owner, ContactEmail: "b@x.y", Name: "B", Fingerprint: "FB", ArmoredKey: "KB"},
	}
	saved, skipped, err := s.BulkUpsertContacts(owner, contacts, dek)
	if err != nil {
		t.Fatalf("BulkUpsertContacts: %v", err)
	}
	if saved != 2 || len(skipped) != 0 {
		t.Fatalf("saved=%d skipped=%v, want 2 / empty", saved, skipped)
	}

	// 再 bulk 一次，全部略過
	saved, skipped, err = s.BulkUpsertContacts(owner, contacts, dek)
	if err != nil {
		t.Fatalf("BulkUpsertContacts: %v", err)
	}
	if saved != 0 || len(skipped) != 2 {
		t.Fatalf("saved=%d skipped=%v, want 0 / 2", saved, skipped)
	}
}

func TestKeyringCRUD(t *testing.T) {
	s := newTestStore(t)
	dek := testDEK()

	got, err := s.GetKeyring("a@b.c", dek)
	if err != nil || got != nil {
		t.Fatalf("expected (nil, nil) for missing keyring, got %+v, %v", got, err)
	}

	k := &Keyring{
		Email:                      "a@b.c",
		PublicKeyArmored:           "PUB",
		EncryptedPrivateKeyArmored: "PRIV",
		Fingerprint:                "FP",
		KeyID:                      "KID",
	}
	if err := s.SaveKeyring(k, dek); err != nil {
		t.Fatalf("SaveKeyring: %v", err)
	}
	raw := rawCol(t, s, `SELECT public_key_armored || '|' || fingerprint FROM personal_keyrings`)
	if !strings.HasPrefix(raw, "e1:") || strings.Contains(raw, "PUB") || strings.Contains(raw, "FP|") {
		t.Fatalf("keyring columns not encrypted: %s", raw)
	}

	got, err = s.GetKeyring("a@b.c", dek)
	if err != nil {
		t.Fatalf("GetKeyring: %v", err)
	}
	if got.PublicKeyArmored != "PUB" || got.EncryptedPrivateKeyArmored != "PRIV" {
		t.Fatalf("unexpected keyring: %+v", got)
	}

	// 更新
	k.EncryptedPrivateKeyArmored = "PRIV2"
	if err := s.SaveKeyring(k, dek); err != nil {
		t.Fatalf("SaveKeyring update: %v", err)
	}
	got, _ = s.GetKeyring("a@b.c", dek)
	if got.EncryptedPrivateKeyArmored != "PRIV2" {
		t.Fatalf("keyring not updated: %+v", got)
	}

	// 錯誤 DEK 讀唔到（加密確實生效）
	if _, err := s.GetKeyring("a@b.c", make([]byte, 32)); err == nil {
		t.Fatal("wrong dek must fail reading keyring")
	}

	if err := s.DeleteKeyring("a@b.c"); err != nil {
		t.Fatalf("DeleteKeyring: %v", err)
	}
	if got, _ := s.GetKeyring("a@b.c", dek); got != nil {
		t.Fatal("keyring should be gone after delete")
	}
}

func TestSaveKeyringValidation(t *testing.T) {
	s := newTestStore(t)
	dek := testDEK()
	if err := s.SaveKeyring(&Keyring{PublicKeyArmored: "P", EncryptedPrivateKeyArmored: "E"}, dek); err == nil {
		t.Fatal("expected error when email missing")
	}
	if err := s.SaveKeyring(&Keyring{Email: "a@b.c"}, dek); err == nil {
		t.Fatal("expected error when key material missing")
	}
}

func TestAccountCRUD(t *testing.T) {
	s := newTestStore(t)
	dek := testDEK()

	// 空清單
	got, err := s.ListAccounts("u@x.com", dek)
	if err != nil {
		t.Fatalf("ListAccounts: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("expected 0 accounts, got %d", len(got))
	}

	a := &Account{
		UserEmail:       "u@x.com",
		Label:           "公司信箱",
		Email:           "work@x.com",
		IMAPHost:        "imap.x.com",
		IMAPPort:        993,
		IMAPUseTLS:      true,
		SMTPHost:        "smtp.x.com",
		SMTPPort:        587,
		SMTPUseTLS:      true,
		Username:        "work@x.com",
		EncIMAPPassword: "ENC_IMAP",
		EncSMTPPassword: "ENC_SMTP",
		IsDefault:       true,
		SortOrder:       0,
	}
	if err := s.CreateAccount(a, dek); err != nil {
		t.Fatalf("CreateAccount: %v", err)
	}

	// 建立時 id 會生成
	if a.ID == "" {
		t.Fatal("expected generated account id")
	}

	// DB 落盤無任何明文
	raw := rawCol(t, s, `SELECT owner_id || '|' || label || '|' || email || '|' || imap_host || '|' || smtp_host || '|' || sieve_host || '|' || username FROM accounts`)
	for _, secret := range []string{"u@x.com", "公司信箱", "work@x.com", "imap.x.com", "smtp.x.com"} {
		if strings.Contains(raw, secret) {
			t.Fatalf("accounts leaks %q: %s", secret, raw)
		}
	}
	if !strings.Contains(raw, "e1:") {
		t.Fatalf("accounts content columns not e1: encoded: %s", raw)
	}

	// Get
	loaded, err := s.GetAccount("u@x.com", a.ID, dek)
	if err != nil {
		t.Fatalf("GetAccount: %v", err)
	}
	if loaded == nil || loaded.Email != "work@x.com" || loaded.EncIMAPPassword != "ENC_IMAP" {
		t.Fatalf("unexpected account: %+v", loaded)
	}
	if !loaded.IsDefault {
		t.Fatal("account should be default")
	}
	if !loaded.IMAPUseTLS || !loaded.SMTPUseTLS {
		t.Fatal("TLS flags should be preserved")
	}

	// Update
	loaded.Label = "私人信箱"
	if err := s.UpdateAccount(loaded, dek); err != nil {
		t.Fatalf("UpdateAccount: %v", err)
	}
	reloaded, _ := s.GetAccount("u@x.com", a.ID, dek)
	if reloaded.Label != "私人信箱" {
		t.Fatalf("label = %q, want 私人信箱", reloaded.Label)
	}

	// SetDefault (新增另一帳號)
	b := &Account{UserEmail: "u@x.com", Label: "B", Email: "b@x.com", IMAPHost: "imap", IMAPPort: 993, SMTPHost: "smtp", SMTPPort: 587, Username: "b", EncIMAPPassword: "E", EncSMTPPassword: "S"}
	if err := s.CreateAccount(b, dek); err != nil {
		t.Fatalf("CreateAccount b: %v", err)
	}
	if err := s.SetDefaultAccount("u@x.com", b.ID); err != nil {
		t.Fatalf("SetDefaultAccount: %v", err)
	}
	list, _ := s.ListAccounts("u@x.com", dek)
	if len(list) != 2 {
		t.Fatalf("expected 2 accounts, got %d", len(list))
	}
	for _, acc := range list {
		if acc.ID == b.ID && !acc.IsDefault {
			t.Fatal("b should be default")
		}
		if acc.ID == a.ID && acc.IsDefault {
			t.Fatal("a should no longer be default")
		}
	}

	// Count
	n, err := s.CountAccounts("u@x.com")
	if err != nil || n != 2 {
		t.Fatalf("CountAccounts = %d, err %v, want 2", n, err)
	}

	// Delete
	if err := s.DeleteAccount("u@x.com", a.ID); err != nil {
		t.Fatalf("DeleteAccount: %v", err)
	}
	if got, _ := s.GetAccount("u@x.com", a.ID, dek); got != nil {
		t.Fatal("account should be gone after delete")
	}
}

func TestCreateAccountValidation(t *testing.T) {
	s := newTestStore(t)
	if err := s.CreateAccount(&Account{UserEmail: "u@x.com"}, testDEK()); err == nil {
		t.Fatal("expected error when passwords missing")
	}
}

func TestUserCredentialCRUD(t *testing.T) {
	s := newTestStore(t)

	got, err := s.GetUserCredential("u@x.com")
	if err != nil {
		t.Fatalf("GetUserCredential: %v", err)
	}
	if got != nil {
		t.Fatal("expected nil for missing credential")
	}

	cred := &UserCredential{UserEmail: "u@x.com", Salt: []byte("somesalt12345678"), WrappedDEK: "wrapped-dek"}
	if err := s.CreateUserCredential(cred); err != nil {
		t.Fatalf("CreateUserCredential: %v", err)
	}
	raw := rawCol(t, s, `SELECT owner_id FROM users`)
	if strings.Contains(raw, "u@x.com") {
		t.Fatalf("users stores plaintext email: %s", raw)
	}

	got, _ = s.GetUserCredential("u@x.com")
	if got == nil || got.WrappedDEK != "wrapped-dek" || string(got.Salt) != "somesalt12345678" {
		t.Fatalf("unexpected credential: %+v", got)
	}

	// Update
	got.WrappedDEK = "wrapped-dek-2"
	if err := s.UpdateUserCredential(got); err != nil {
		t.Fatalf("UpdateUserCredential: %v", err)
	}
	reloaded, _ := s.GetUserCredential("u@x.com")
	if reloaded.WrappedDEK != "wrapped-dek-2" {
		t.Fatalf("wrapped_dek = %q, want wrapped-dek-2", reloaded.WrappedDEK)
	}
}

func TestUserPrefs(t *testing.T) {
	s, err := NewSQLiteStore(t.TempDir())
	if err != nil {
		t.Fatalf("NewSQLiteStore: %v", err)
	}
	defer func() { _ = s.Close() }()
	dek := testDEK()

	// 未設定 → ""
	v, err := s.GetUserPref("a@b.c", "listMode", dek)
	if err != nil {
		t.Fatalf("GetUserPref missing: %v", err)
	}
	if v != "" {
		t.Fatalf("missing pref = %q, want empty", v)
	}

	if err := s.SetUserPref("a@b.c", "listMode", "threads", dek); err != nil {
		t.Fatalf("SetUserPref: %v", err)
	}
	v, _ = s.GetUserPref("a@b.c", "listMode", dek)
	if v != "threads" {
		t.Fatalf("pref = %q, want threads", v)
	}

	// upsert 覆寫
	if err := s.SetUserPref("a@b.c", "listMode", "messages", dek); err != nil {
		t.Fatalf("SetUserPref upsert: %v", err)
	}
	v, _ = s.GetUserPref("a@b.c", "listMode", dek)
	if v != "messages" {
		t.Fatalf("pref = %q, want messages", v)
	}

	// per-user 隔離
	if err := s.SetUserPref("other@b.c", "listMode", "threads", dek); err != nil {
		t.Fatalf("SetUserPref other: %v", err)
	}
	v, _ = s.GetUserPref("a@b.c", "listMode", dek)
	if v != "messages" {
		t.Fatalf("owner isolation broken: %q", v)
	}
}

func TestFolderPrefsAndOrder(t *testing.T) {
	s := newTestStore(t)
	dek := testDEK()

	if err := s.SetFolderPref("u@x.com", "acc1", "Gmail/Label", false, dek); err != nil {
		t.Fatalf("SetFolderPref: %v", err)
	}
	prefs, err := s.ListFolderPrefs("u@x.com", "acc1", dek)
	if err != nil {
		t.Fatalf("ListFolderPrefs: %v", err)
	}
	if prefs["Gmail/Label"] != false {
		t.Fatalf("prefs = %v", prefs)
	}
	if rawCol(t, s, `SELECT folder_name FROM folder_prefs`) == "Gmail/Label" {
		t.Fatal("folder_prefs stores plaintext")
	}

	names := []string{"INBOX", "JobsDB", "八達通"}
	if err := s.SetFolderOrder("u@x.com", "acc1", names, dek); err != nil {
		t.Fatalf("SetFolderOrder: %v", err)
	}
	got, err := s.GetFolderOrder("u@x.com", "acc1", dek)
	if err != nil {
		t.Fatalf("GetFolderOrder: %v", err)
	}
	if strings.Join(got, ",") != strings.Join(names, ",") {
		t.Fatalf("order = %v, want %v", got, names)
	}
	// folder 名稱大小寫敏感（HashID 唔 lower）
	if err := s.SetFolderPref("u@x.com", "acc1", "inbox", true, dek); err != nil {
		t.Fatal(err)
	}
	prefs2, _ := s.ListFolderPrefs("u@x.com", "acc1", dek)
	if _, hasInbox := prefs2["inbox"]; !hasInbox {
		t.Fatal("case-sensitive folder name lost")
	}
}

func TestAddressBookSearch(t *testing.T) {
	s := newTestStore(t)
	dek := testDEK()
	for _, c := range []*Contact{
		{OwnerEmail: "u@x.com", Email: "alice@corp.com", DisplayName: "AliceCorp", Note: "工作"},
		{OwnerEmail: "u@x.com", Email: "bob@mail.com", DisplayName: "Bob", Note: ""},
	} {
		if err := s.CreateAddressContact(c, dek); err != nil {
			t.Fatalf("CreateAddressContact: %v", err)
		}
	}

	all, _ := s.ListAddressContacts("u@x.com", "", 0, 0, dek)
	if len(all) != 2 {
		t.Fatalf("all = %d", len(all))
	}
	byName, _ := s.ListAddressContacts("u@x.com", "alice", 0, 0, dek)
	if len(byName) != 1 || byName[0].Email != "alice@corp.com" {
		t.Fatalf("search by name: %+v", byName)
	}
	byNote, _ := s.ListAddressContacts("u@x.com", "工作", 10, 0, dek)
	if len(byNote) != 1 {
		t.Fatalf("search note: %+v", byNote)
	}
	// 大細寫 email 等值
	one, err := s.GetAddressContactByEmail("u@x.com", "Alice@Corp.COM", dek)
	if err != nil || one == nil {
		t.Fatalf("GetAddressContactByEmail: %v %v", one, err)
	}
	res, err := s.ResolveAddressContacts("u@x.com", []string{"alice@corp.com", "nobody@x.com"}, dek)
	if err != nil || len(res) != 1 {
		t.Fatalf("resolve: %d %v", len(res), err)
	}
}

func TestLazyPendingConversion(t *testing.T) {
	s := newTestStore(t)
	dek := testDEK()

	// 模擬遷移態：owner 有 pending 行 + 未轉換內容
	if err := s.CreateUserCredential(&UserCredential{UserEmail: "u@x.com", Salt: []byte("saltsaltsaltsalt"), WrappedDEK: "wd"}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.Exec(`UPDATE users SET pending_encrypt = 1 WHERE owner_id = ?`, crypto.OwnerID("u@x.com")); err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.Exec(`INSERT INTO accounts (id, owner_id, label, email, imap_host, imap_port, smtp_host, smtp_port, username, enc_imap_password, enc_smtp_password, created_at, updated_at)
		VALUES ('a1', ?, '公司信箱', 'u@x.com', 'mail.x.com', 993, 'smtp.x.com', 587, 'u@x.com', 'EP', 'EP', 1, 1)`,
		crypto.OwnerID("u@x.com")); err != nil {
		t.Fatal(err)
	}
	// 標記為 pending（用 WrapField(nil) 產生合法 p: 值）
	pend := func(s string) string { v, _ := crypto.WrapField(nil, s); return v }
	if _, err := s.db.Exec(`UPDATE accounts SET label = ?, email = ?, imap_host = ?, smtp_host = ?, username = ? WHERE id = 'a1'`,
		pend("公司信箱"), pend("u@x.com"), pend("mail.x.com"), pend("smtp.x.com"), pend("u@x.com")); err != nil {
		t.Fatal(err)
	}

	pending, err := s.HasPendingEncrypt("u@x.com")
	if err != nil || !pending {
		t.Fatalf("HasPendingEncrypt = %v %v", pending, err)
	}
	// pending 都讀到（明文透視）
	acc, err := s.GetAccount("u@x.com", "a1", dek)
	if err != nil || acc == nil || acc.Label != "公司信箱" {
		t.Fatalf("pending account readable: %+v %v", acc, err)
	}

	// 遷移後尚未轉換欄目計入審計
	cnt, err := s.CountPendingFields()
	if err != nil || cnt == 0 {
		t.Fatalf("CountPendingFields = %d %v", cnt, err)
	}

	n, err := s.EncryptPendingFields("u@x.com", dek)
	if err != nil || n != 5 {
		t.Fatalf("EncryptPendingFields = %d %v, want 5", n, err)
	}
	// 轉換後 e1: 讀寫正常
	acc2, err := s.GetAccount("u@x.com", "a1", dek)
	if err != nil || acc2 == nil || acc2.Email != "u@x.com" || acc2.IMAPHost != "mail.x.com" {
		t.Fatalf("post-lazy read: %+v %v", acc2, err)
	}
	if pending, _ := s.HasPendingEncrypt("u@x.com"); pending {
		t.Fatal("pending flag not cleared")
	}
	if cnt, _ := s.CountPendingFields(); cnt != 0 {
		t.Fatalf("residual pending after conversion: %d", cnt)
	}
	// 冪等：再跑一次 0 轉換
	if n2, err := s.EncryptPendingFields("u@x.com", dek); err != nil || n2 != 0 {
		t.Fatalf("idempotent = %d %v", n2, err)
	}
}
