package storage

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestBackupPeriodKey(t *testing.T) {
	// 2026-09-07 是 ISO week 2026-W37
	d := time.Date(2026, 9, 7, 15, 0, 0, 0, time.UTC)
	if got := backupPeriodKey(backupDaily, d); got != "2026-09-07" {
		t.Fatalf("daily = %q", got)
	}
	if got := backupPeriodKey(backupWeekly, d); got != "2026-W37" {
		t.Fatalf("weekly = %q", got)
	}
	if got := backupPeriodKey(backupMonthly, d); got != "2026-09" {
		t.Fatalf("monthly = %q", got)
	}
	if got := backupPeriodKey(backupDisable, d); got != "" {
		t.Fatalf("disable period = %q", got)
	}
}

func TestBackupPeriodKeyISOWeekYearBoundary(t *testing.T) {
	// 2026-12-31 係星期四，ISO week 2026-W53；2027-01-01 仍屬 2026-W53
	thu := time.Date(2026, 12, 31, 0, 0, 0, 0, time.UTC)
	fri := time.Date(2027, 1, 1, 0, 0, 0, 0, time.UTC)
	if got := backupPeriodKey(backupWeekly, thu); got != "2026-W53" {
		t.Fatalf("2026-12-31 weekly = %q", got)
	}
	if got := backupPeriodKey(backupWeekly, fri); got != "2026-W53" {
		t.Fatalf("2027-01-01 weekly = %q, want same ISO week as 2026-12-31", got)
	}
	if got := backupPeriodKey(backupMonthly, fri); got != "2027-01" {
		t.Fatalf("2027-01-01 monthly = %q", got)
	}
}

func TestBackupFileName(t *testing.T) {
	d := time.Date(2026, 9, 7, 0, 0, 0, 0, time.UTC)
	if got := backupFileName(backupDaily, d); got != "e2Mail.daily.2026-09-07.db" {
		t.Fatalf("daily name = %q", got)
	}
	if got := backupFileName(backupWeekly, d); got != "e2Mail.weekly.2026-W37.db" {
		t.Fatalf("weekly name = %q", got)
	}
	if got := backupFileName(backupMonthly, d); got != "e2Mail.monthly.2026-09.db" {
		t.Fatalf("monthly name = %q", got)
	}
}

func TestBackupRetention(t *testing.T) {
	if backupRetention(backupDaily) != 7 {
		t.Fatal("daily retention")
	}
	if backupRetention(backupWeekly) != 4 {
		t.Fatal("weekly retention")
	}
	if backupRetention(backupMonthly) != 12 {
		t.Fatal("monthly retention")
	}
	if backupRetention(backupDisable) != 0 {
		t.Fatal("disable retention")
	}
}

func TestQuoteSQLString(t *testing.T) {
	if got := quoteSQLString(`/data/backups/e2Mail.db`); got != `'/data/backups/e2Mail.db'` {
		t.Fatalf("got %q", got)
	}
	if got := quoteSQLString(`it's`); got != `'it''s'` {
		t.Fatalf("quote = %q", got)
	}
}

func TestSQLiteStoreBackupEmptyPath(t *testing.T) {
	s := newTestStore(t)
	if err := s.Backup(""); err == nil {
		t.Fatal("expected error for empty dest")
	}
}

func TestSQLiteStoreBackupRoundTrip(t *testing.T) {
	dir := t.TempDir()
	s, err := NewSQLiteStore(dir)
	if err != nil {
		t.Fatalf("NewSQLiteStore: %v", err)
	}
	t.Cleanup(func() { _ = s.Close() })

	tf := &TwoFA{OwnerEmail: "a@b.c", Secret: "BACKUP-SECRET", BackupHashes: []string{"h"}}
	if err := s.SaveTwoFA(tf); err != nil {
		t.Fatalf("SaveTwoFA: %v", err)
	}

	dest := filepath.Join(dir, "backups", "e2Mail.daily.2026-09-07.db")
	if err := s.Backup(dest); err != nil {
		t.Fatalf("Backup: %v", err)
	}
	if _, err := os.Stat(dest); err != nil {
		t.Fatalf("backup file missing: %v", err)
	}

	restoreDir := t.TempDir()
	raw, err := os.ReadFile(dest)
	if err != nil {
		t.Fatalf("read backup: %v", err)
	}
	if err := os.WriteFile(filepath.Join(restoreDir, "e2Mail.db"), raw, 0600); err != nil {
		t.Fatalf("write restore copy: %v", err)
	}
	restored, err := NewSQLiteStore(restoreDir)
	if err != nil {
		t.Fatalf("open restored store: %v", err)
	}
	t.Cleanup(func() { _ = restored.Close() })

	got, err := restored.GetTwoFA("a@b.c")
	if err != nil {
		t.Fatalf("GetTwoFA from backup: %v", err)
	}
	if got == nil || got.Secret != "BACKUP-SECRET" {
		t.Fatalf("backup content = %+v", got)
	}
}

func TestDBBackupRunIfDueDisableNoop(t *testing.T) {
	dir := t.TempDir()
	s, err := NewSQLiteStore(dir)
	if err != nil {
		t.Fatalf("NewSQLiteStore: %v", err)
	}
	t.Cleanup(func() { _ = s.Close() })

	backupDir := filepath.Join(dir, backupSubdir)
	r := &dbBackupRunner{
		store:    s,
		dir:      backupDir,
		schedule: backupDisable,
		now:      func() time.Time { return time.Date(2026, 9, 7, 0, 0, 0, 0, time.UTC) },
	}
	if err := r.runIfDue(); err != nil {
		t.Fatalf("runIfDue DISABLE: %v", err)
	}
	if _, err := os.Stat(backupDir); !os.IsNotExist(err) {
		t.Fatal("DISABLE must not create backups dir")
	}
}

func TestDBBackupRunIfDueSkipsExisting(t *testing.T) {
	dir := t.TempDir()
	s, err := NewSQLiteStore(dir)
	if err != nil {
		t.Fatalf("NewSQLiteStore: %v", err)
	}
	t.Cleanup(func() { _ = s.Close() })

	now := time.Date(2026, 9, 7, 12, 0, 0, 0, time.UTC)
	backupDir := filepath.Join(dir, backupSubdir)
	r := &dbBackupRunner{store: s, dir: backupDir, schedule: backupDaily, now: func() time.Time { return now }}

	if err := r.runIfDue(); err != nil {
		t.Fatalf("first runIfDue: %v", err)
	}
	dest := r.destPath(now)
	info1, err := os.Stat(dest)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}

	if err := r.runIfDue(); err != nil {
		t.Fatalf("second runIfDue: %v", err)
	}
	info2, err := os.Stat(dest)
	if err != nil {
		t.Fatalf("stat2: %v", err)
	}
	if !info1.ModTime().Equal(info2.ModTime()) {
		t.Fatal("second run should not rewrite backup for same period")
	}
}

func TestDBBackupRunIfDueWeeklyNewPeriod(t *testing.T) {
	dir := t.TempDir()
	s, err := NewSQLiteStore(dir)
	if err != nil {
		t.Fatalf("NewSQLiteStore: %v", err)
	}
	t.Cleanup(func() { _ = s.Close() })

	backupDir := filepath.Join(dir, backupSubdir)
	weekA := time.Date(2026, 8, 31, 0, 0, 0, 0, time.UTC) // 2026-W36
	weekB := time.Date(2026, 9, 7, 0, 0, 0, 0, time.UTC)  // 2026-W37
	now := weekA
	r := &dbBackupRunner{store: s, dir: backupDir, schedule: backupWeekly, now: func() time.Time { return now }}
	if err := r.runIfDue(); err != nil {
		t.Fatalf("week A: %v", err)
	}
	now = weekB
	if err := r.runIfDue(); err != nil {
		t.Fatalf("week B: %v", err)
	}
	if _, err := os.Stat(r.destPath(weekA)); err != nil {
		t.Fatalf("week A file: %v", err)
	}
	if _, err := os.Stat(r.destPath(weekB)); err != nil {
		t.Fatalf("week B file: %v", err)
	}
}

func TestDBBackupPruneKeepsRetention(t *testing.T) {
	dir := t.TempDir()
	s, err := NewSQLiteStore(dir)
	if err != nil {
		t.Fatalf("NewSQLiteStore: %v", err)
	}
	t.Cleanup(func() { _ = s.Close() })

	backupDir := filepath.Join(dir, backupSubdir)
	if err := os.MkdirAll(backupDir, 0700); err != nil {
		t.Fatal(err)
	}
	// DAILY 保留 7 份：先造 9 個空檔再跑一次真正備份
	for i := 1; i <= 9; i++ {
		name := filepath.Join(backupDir, backupFileName(backupDaily, time.Date(2026, 8, i, 0, 0, 0, 0, time.UTC)))
		if err := os.WriteFile(name, []byte("x"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	now := time.Date(2026, 9, 7, 0, 0, 0, 0, time.UTC)
	r := &dbBackupRunner{store: s, dir: backupDir, schedule: backupDaily, now: func() time.Time { return now }}
	if err := r.runIfDue(); err != nil {
		t.Fatalf("runIfDue: %v", err)
	}

	entries, err := os.ReadDir(backupDir)
	if err != nil {
		t.Fatal(err)
	}
	var dbs []string
	for _, e := range entries {
		if !e.IsDir() && filepath.Ext(e.Name()) == ".db" {
			dbs = append(dbs, e.Name())
		}
	}
	if len(dbs) != 7 {
		t.Fatalf("kept %d backups, want 7: %v", len(dbs), dbs)
	}
	wantCurrent := backupFileName(backupDaily, now)
	found := false
	for _, n := range dbs {
		if n == wantCurrent {
			found = true
		}
	}
	if !found {
		t.Fatalf("current period backup %s missing: %v", wantCurrent, dbs)
	}
}

func TestStartDBBackupDisableClosesImmediately(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := StartDBBackup(ctx, nil, t.TempDir(), backupDisable)
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("DISABLE should close done immediately")
	}
}

func TestStartDBBackupWritesAndStops(t *testing.T) {
	dir := t.TempDir()
	s, err := NewSQLiteStore(dir)
	if err != nil {
		t.Fatalf("NewSQLiteStore: %v", err)
	}
	t.Cleanup(func() { _ = s.Close() })

	ctx, cancel := context.WithCancel(context.Background())
	done := StartDBBackup(ctx, s, dir, backupDaily)

	deadline := time.Now().Add(5 * time.Second)
	found := false
	for time.Now().Before(deadline) {
		matches, _ := filepath.Glob(filepath.Join(dir, backupSubdir, "e2Mail.daily.*.db"))
		if len(matches) > 0 {
			found = true
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if !found {
		cancel()
		t.Fatal("expected a daily backup file shortly after start")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("scheduler did not stop after cancel")
	}
}
