package config

import (
	"testing"
)

func TestParseDBBackup(t *testing.T) {
	cases := []struct {
		in     string
		want   DBBackupSchedule
		wantOK bool
	}{
		{"", DBBackupDisable, true},
		{"DISABLE", DBBackupDisable, true},
		{"disable", DBBackupDisable, true},
		{"  Disable  ", DBBackupDisable, true},
		{"DAILY", DBBackupDaily, true},
		{" daily ", DBBackupDaily, true},
		{"WEEKLY", DBBackupWeekly, true},
		{"weekly", DBBackupWeekly, true},
		{"MONTHLY", DBBackupMonthly, true},
		{"monthly", DBBackupMonthly, true},
		{"HOURLY", DBBackupDisable, false},
		{"true", DBBackupDisable, false},
		{"1", DBBackupDisable, false},
		{"YEARLY", DBBackupDisable, false},
	}
	for _, tc := range cases {
		got, ok := ParseDBBackup(tc.in)
		if got != tc.want || ok != tc.wantOK {
			t.Errorf("ParseDBBackup(%q) = (%q, %v), want (%q, %v)", tc.in, got, ok, tc.want, tc.wantOK)
		}
	}
}

func TestLoadDBBackupDefaultDisable(t *testing.T) {
	t.Setenv("DB_BACKUP", "")
	cfg := Load()
	if cfg.DBBackup != DBBackupDisable {
		t.Fatalf("default DBBackup = %q, want DISABLE", cfg.DBBackup)
	}
}

func TestLoadDBBackupSchedules(t *testing.T) {
	t.Run("daily", func(t *testing.T) {
		t.Setenv("DB_BACKUP", "DAILY")
		if got := Load().DBBackup; got != DBBackupDaily {
			t.Fatalf("got %q", got)
		}
	})
	t.Run("weekly", func(t *testing.T) {
		t.Setenv("DB_BACKUP", "weekly")
		if got := Load().DBBackup; got != DBBackupWeekly {
			t.Fatalf("got %q", got)
		}
	})
	t.Run("monthly", func(t *testing.T) {
		t.Setenv("DB_BACKUP", "Monthly")
		if got := Load().DBBackup; got != DBBackupMonthly {
			t.Fatalf("got %q", got)
		}
	})
	t.Run("invalid", func(t *testing.T) {
		t.Setenv("DB_BACKUP", "HOURLY")
		if got := Load().DBBackup; got != DBBackupDisable {
			t.Fatalf("invalid should fall back to DISABLE, got %q", got)
		}
	})
}
