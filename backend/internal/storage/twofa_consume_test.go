package storage

import "testing"

func newTwoFAStoreForTest(t *testing.T) *SQLiteStore {
	t.Helper()
	s, err := NewSQLiteStore(t.TempDir())
	if err != nil {
		t.Fatalf("NewSQLiteStore: %v", err)
	}
	t.Cleanup(func() { _ = s.Close() })
	if err := s.SaveTwoFA(&TwoFA{OwnerEmail: "u@example.com", Secret: "S", BackupHashes: []string{"h1", "h2"}}); err != nil {
		t.Fatalf("SaveTwoFA: %v", err)
	}
	return s
}

// 同一 TOTP step 只可成功一次（重放防護）；較早 step 亦不可再用。
func TestConsumeTOTPStepRejectsReplay(t *testing.T) {
	s := newTwoFAStoreForTest(t)

	ok, err := s.ConsumeTOTPStep("u@example.com", 100)
	if err != nil || !ok {
		t.Fatalf("first use of step 100: ok=%v err=%v", ok, err)
	}
	ok, err = s.ConsumeTOTPStep("u@example.com", 100)
	if err != nil || ok {
		t.Fatalf("replay of step 100 must be rejected: ok=%v err=%v", ok, err)
	}
	ok, err = s.ConsumeTOTPStep("u@example.com", 99)
	if err != nil || ok {
		t.Fatalf("older step 99 must be rejected: ok=%v err=%v", ok, err)
	}
	ok, err = s.ConsumeTOTPStep("u@example.com", 101)
	if err != nil || !ok {
		t.Fatalf("newer step 101 should be accepted: ok=%v err=%v", ok, err)
	}
}

// 備份碼只可消耗一次；並發／重複提交第二次必須失敗。
func TestConsumeBackupCodeIsSingleUse(t *testing.T) {
	s := newTwoFAStoreForTest(t)

	ok, err := s.ConsumeBackupCode("u@example.com", "h1")
	if err != nil || !ok {
		t.Fatalf("first consume h1: ok=%v err=%v", ok, err)
	}
	ok, err = s.ConsumeBackupCode("u@example.com", "h1")
	if err != nil || ok {
		t.Fatalf("second consume h1 must fail: ok=%v err=%v", ok, err)
	}
	tf, err := s.GetTwoFA("u@example.com")
	if err != nil || tf == nil {
		t.Fatalf("GetTwoFA: %v", err)
	}
	if len(tf.BackupHashes) != 1 || tf.BackupHashes[0] != "h2" {
		t.Fatalf("remaining hashes = %v, want [h2]", tf.BackupHashes)
	}
}

// 舊資料庫（two_fa 冇 last_totp_step 欄）開啟時要自動補欄，且資料保留。
func TestLegacyTwoFATableGetsTOTPStepColumn(t *testing.T) {
	dir := t.TempDir()
	s, err := NewSQLiteStore(dir)
	if err != nil {
		t.Fatalf("NewSQLiteStore: %v", err)
	}
	if _, err := s.db.Exec(`ALTER TABLE two_fa DROP COLUMN last_totp_step`); err != nil {
		t.Fatalf("simulate legacy schema: %v", err)
	}
	if err := s.SaveTwoFA(&TwoFA{OwnerEmail: "old@example.com", Secret: "S", BackupHashes: []string{"x"}}); err != nil {
		t.Fatalf("SaveTwoFA: %v", err)
	}
	_ = s.Close()

	s2, err := NewSQLiteStore(dir)
	if err != nil {
		t.Fatalf("reopen legacy db: %v", err)
	}
	t.Cleanup(func() { _ = s2.Close() })
	if ok, err := s2.ConsumeTOTPStep("old@example.com", 5); err != nil || !ok {
		t.Fatalf("ConsumeTOTPStep after migration: ok=%v err=%v", ok, err)
	}
}
