package storage

import (
	"testing"
)

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
	owner := "me@a.b"

	c := ContactKey{
		OwnerEmail:   owner,
		ContactEmail: "them@a.b",
		Name:         "Them",
		Fingerprint:  "FP1",
		KeyID:        "KID1",
		ArmoredKey:   "PUBKEY",
	}
	if err := s.UpsertContact(c); err != nil {
		t.Fatalf("UpsertContact: %v", err)
	}

	got, err := s.GetContact(owner, "them@a.b")
	if err != nil {
		t.Fatalf("GetContact: %v", err)
	}
	if got == nil || got.Name != "Them" || got.Fingerprint != "FP1" {
		t.Fatalf("unexpected contact: %+v", got)
	}

	missing, err := s.GetContact(owner, "nobody@a.b")
	if err != nil || missing != nil {
		t.Fatalf("expected (nil, nil) for missing contact, got %+v, %v", missing, err)
	}

	// upsert 更新
	c.Name = "Renamed"
	c.Fingerprint = "FP2"
	if err := s.UpsertContact(c); err != nil {
		t.Fatalf("UpsertContact update: %v", err)
	}
	got, _ = s.GetContact(owner, "them@a.b")
	if got.Name != "Renamed" || got.Fingerprint != "FP2" {
		t.Fatalf("contact not updated: %+v", got)
	}

	list, err := s.ListContacts(owner)
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
	if missing, _ := s.GetContact(owner, "them@a.b"); missing != nil {
		t.Fatal("contact should be gone after delete")
	}
}

func TestContactsScopedByOwner(t *testing.T) {
	s := newTestStore(t)
	c := ContactKey{OwnerEmail: "me@a.b", ContactEmail: "x@y.z", Fingerprint: "F", ArmoredKey: "K"}
	if err := s.UpsertContact(c); err != nil {
		t.Fatalf("UpsertContact: %v", err)
	}
	if got, _ := s.GetContact("other@a.b", "x@y.z"); got != nil {
		t.Fatal("contact must not leak across owners")
	}
}

func TestUpsertContactValidation(t *testing.T) {
	s := newTestStore(t)
	c := ContactKey{OwnerEmail: "me@a.b", ContactEmail: "", Fingerprint: "F", ArmoredKey: "K"}
	if err := s.UpsertContact(c); err == nil {
		t.Fatal("expected error when contact email missing")
	}
	c.ContactEmail = "x@y.z"
	c.Fingerprint = ""
	if err := s.UpsertContact(c); err == nil {
		t.Fatal("expected error when fingerprint missing")
	}
}

func TestBulkUpsertContacts(t *testing.T) {
	s := newTestStore(t)
	owner := "me@a.b"
	contacts := []ContactKey{
		{OwnerEmail: owner, ContactEmail: "a@x.y", Name: "A", Fingerprint: "FA", ArmoredKey: "KA"},
		{OwnerEmail: owner, ContactEmail: "b@x.y", Name: "B", Fingerprint: "FB", ArmoredKey: "KB"},
	}
	saved, skipped, err := s.BulkUpsertContacts(owner, contacts)
	if err != nil {
		t.Fatalf("BulkUpsertContacts: %v", err)
	}
	if saved != 2 || len(skipped) != 0 {
		t.Fatalf("saved=%d skipped=%v, want 2 / empty", saved, skipped)
	}

	// 再 bulk 一次，全部略過
	saved, skipped, err = s.BulkUpsertContacts(owner, contacts)
	if err != nil {
		t.Fatalf("BulkUpsertContacts: %v", err)
	}
	if saved != 0 || len(skipped) != 2 {
		t.Fatalf("saved=%d skipped=%v, want 0 / 2", saved, skipped)
	}
}

func TestKeyringCRUD(t *testing.T) {
	s := newTestStore(t)

	got, err := s.GetKeyring("a@b.c")
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
	if err := s.SaveKeyring(k); err != nil {
		t.Fatalf("SaveKeyring: %v", err)
	}

	got, err = s.GetKeyring("a@b.c")
	if err != nil {
		t.Fatalf("GetKeyring: %v", err)
	}
	if got.PublicKeyArmored != "PUB" || got.EncryptedPrivateKeyArmored != "PRIV" {
		t.Fatalf("unexpected keyring: %+v", got)
	}

	// 更新
	k.EncryptedPrivateKeyArmored = "PRIV2"
	if err := s.SaveKeyring(k); err != nil {
		t.Fatalf("SaveKeyring update: %v", err)
	}
	got, _ = s.GetKeyring("a@b.c")
	if got.EncryptedPrivateKeyArmored != "PRIV2" {
		t.Fatalf("keyring not updated: %+v", got)
	}

	if err := s.DeleteKeyring("a@b.c"); err != nil {
		t.Fatalf("DeleteKeyring: %v", err)
	}
	if got, _ := s.GetKeyring("a@b.c"); got != nil {
		t.Fatal("keyring should be gone after delete")
	}
}

func TestSaveKeyringValidation(t *testing.T) {
	s := newTestStore(t)
	if err := s.SaveKeyring(&Keyring{PublicKeyArmored: "P", EncryptedPrivateKeyArmored: "E"}); err == nil {
		t.Fatal("expected error when email missing")
	}
	if err := s.SaveKeyring(&Keyring{Email: "a@b.c"}); err == nil {
		t.Fatal("expected error when key material missing")
	}
}
func TestAccountCRUD(t *testing.T) {
	s := newTestStore(t)

	// 空清單
	got, err := s.ListAccounts("u@x.com")
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
	if err := s.CreateAccount(a); err != nil {
		t.Fatalf("CreateAccount: %v", err)
	}

	// 建立時 id 會生成
	if a.ID == "" {
		t.Fatal("expected generated account id")
	}

	// Get
	loaded, err := s.GetAccount("u@x.com", a.ID)
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
	if err := s.UpdateAccount(loaded); err != nil {
		t.Fatalf("UpdateAccount: %v", err)
	}
	reloaded, _ := s.GetAccount("u@x.com", a.ID)
	if reloaded.Label != "私人信箱" {
		t.Fatalf("label = %q, want 私人信箱", reloaded.Label)
	}

	// SetDefault (新增另一帳號)
	b := &Account{UserEmail: "u@x.com", Label: "B", Email: "b@x.com", IMAPHost: "imap", IMAPPort: 993, SMTPHost: "smtp", SMTPPort: 587, Username: "b", EncIMAPPassword: "E", EncSMTPPassword: "S"}
	if err := s.CreateAccount(b); err != nil {
		t.Fatalf("CreateAccount b: %v", err)
	}
	if err := s.SetDefaultAccount("u@x.com", b.ID); err != nil {
		t.Fatalf("SetDefaultAccount: %v", err)
	}
	list, _ := s.ListAccounts("u@x.com")
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
	if got, _ := s.GetAccount("u@x.com", a.ID); got != nil {
		t.Fatal("account should be gone after delete")
	}
}

func TestCreateAccountValidation(t *testing.T) {
	s := newTestStore(t)
	if err := s.CreateAccount(&Account{UserEmail: "u@x.com"}); err == nil {
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

	// 未設定 → ""
	v, err := s.GetUserPref("a@b.c", "listMode")
	if err != nil {
		t.Fatalf("GetUserPref missing: %v", err)
	}
	if v != "" {
		t.Fatalf("missing pref = %q, want empty", v)
	}

	if err := s.SetUserPref("a@b.c", "listMode", "threads"); err != nil {
		t.Fatalf("SetUserPref: %v", err)
	}
	v, _ = s.GetUserPref("a@b.c", "listMode")
	if v != "threads" {
		t.Fatalf("pref = %q, want threads", v)
	}

	// upsert 覆寫
	if err := s.SetUserPref("a@b.c", "listMode", "messages"); err != nil {
		t.Fatalf("SetUserPref upsert: %v", err)
	}
	v, _ = s.GetUserPref("a@b.c", "listMode")
	if v != "messages" {
		t.Fatalf("pref = %q, want messages", v)
	}

	// per-user 隔離
	if err := s.SetUserPref("other@b.c", "listMode", "threads"); err != nil {
		t.Fatalf("SetUserPref other: %v", err)
	}
	v, _ = s.GetUserPref("a@b.c", "listMode")
	if v != "messages" {
		t.Fatalf("owner isolation broken: %q", v)
	}
}
