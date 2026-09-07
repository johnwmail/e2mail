package storage

import (
	"context"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

const (
	backupSubdir  = "backups"
	backupDisable = "DISABLE"
	backupDaily   = "DAILY"
	backupWeekly  = "WEEKLY"
	backupMonthly = "MONTHLY"
)

func backupRetention(schedule string) int {
	switch schedule {
	case backupDaily:
		return 7
	case backupWeekly:
		return 4
	case backupMonthly:
		return 12
	default:
		return 0
	}
}

func backupPeriodKey(schedule string, t time.Time) string {
	t = t.UTC()
	switch schedule {
	case backupDaily:
		return t.Format("2006-01-02")
	case backupWeekly:
		y, w := t.ISOWeek()
		return fmt.Sprintf("%04d-W%02d", y, w)
	case backupMonthly:
		return t.Format("2006-01")
	default:
		return ""
	}
}

func backupFileName(schedule string, t time.Time) string {
	return fmt.Sprintf("e2Mail.%s.%s.db", strings.ToLower(schedule), backupPeriodKey(schedule, t))
}

func quoteSQLString(s string) string {
	return "'" + strings.ReplaceAll(s, "'", "''") + "'"
}

// Backup 以 VACUUM INTO 寫入 destPath 的一致快照（WAL-safe）。目標檔不可已存在。
func (s *SQLiteStore) Backup(destPath string) error {
	if destPath == "" {
		return fmt.Errorf("backup dest path is empty")
	}
	if err := os.MkdirAll(filepath.Dir(destPath), 0700); err != nil {
		return fmt.Errorf("failed to create backup dir: %w", err)
	}
	tmp := destPath + ".tmp"
	_ = os.Remove(tmp)
	_ = os.Remove(tmp + "-wal")
	_ = os.Remove(tmp + "-shm")

	s.mu.Lock()
	defer s.mu.Unlock()

	q := "VACUUM INTO " + quoteSQLString(tmp)
	if _, err := s.db.Exec(q); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("VACUUM INTO: %w", err)
	}
	if err := os.Rename(tmp, destPath); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("rename backup: %w", err)
	}
	return nil
}

type dbBackupRunner struct {
	store    *SQLiteStore
	dir      string
	schedule string
	now      func() time.Time
}

func (r *dbBackupRunner) destPath(t time.Time) string {
	return filepath.Join(r.dir, backupFileName(r.schedule, t))
}

func (r *dbBackupRunner) runIfDue() error {
	if r.schedule == backupDisable || r.schedule == "" {
		return nil
	}
	now := r.now()
	dest := r.destPath(now)
	if _, err := os.Stat(dest); err == nil {
		return nil
	} else if !os.IsNotExist(err) {
		return err
	}
	if err := r.store.Backup(dest); err != nil {
		return err
	}
	log.Printf("💾 DB backup written: %s (DB_BACKUP=%s)", dest, r.schedule)
	return r.prune(now)
}

func (r *dbBackupRunner) prune(now time.Time) error {
	keep := backupRetention(r.schedule)
	if keep <= 0 {
		return nil
	}
	prefix := fmt.Sprintf("e2Mail.%s.", strings.ToLower(r.schedule))
	entries, err := os.ReadDir(r.dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	var files []string
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		name := e.Name()
		if strings.HasPrefix(name, prefix) && strings.HasSuffix(name, ".db") {
			files = append(files, name)
		}
	}
	sort.Strings(files)
	current := backupFileName(r.schedule, now)
	for len(files) > keep {
		oldest := files[0]
		files = files[1:]
		if oldest == current {
			continue
		}
		if err := os.Remove(filepath.Join(r.dir, oldest)); err != nil && !os.IsNotExist(err) {
			return err
		}
		log.Printf("💾 DB backup pruned: %s", oldest)
	}
	return nil
}

// StartDBBackup 按 DB_BACKUP 週期自動備份 dataDir/e2Mail.db 到 dataDir/backups/。
// DISABLE 時立即關閉 done。關閉 ctx 後 goroutine 結束並 close(done)。
func StartDBBackup(ctx context.Context, store *SQLiteStore, dataDir, schedule string) <-chan struct{} {
	done := make(chan struct{})
	if schedule == backupDisable || schedule == "" || store == nil {
		close(done)
		return done
	}
	runner := &dbBackupRunner{
		store:    store,
		dir:      filepath.Join(dataDir, backupSubdir),
		schedule: schedule,
		now:      time.Now,
	}
	log.Printf("💾 DB backup enabled: %s → %s (retention %d)", schedule, runner.dir, backupRetention(schedule))
	go func() {
		defer close(done)
		if err := runner.runIfDue(); err != nil {
			log.Printf("⚠️  DB backup failed: %v", err)
		}
		ticker := time.NewTicker(time.Hour)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if err := runner.runIfDue(); err != nil {
					log.Printf("⚠️  DB backup failed: %v", err)
				}
			}
		}
	}()
	return done
}
