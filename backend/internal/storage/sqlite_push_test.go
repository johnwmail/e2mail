package storage

import (
	"strings"
	"testing"
	"time"
)

func TestPushDeviceRoundTripAndCiphertext(t *testing.T) {
	s := newTestStore(t)
	dek := testDEK()
	d := PushDevice{
		OwnerEmail: "Owner@Example.com",
		SessionID:  "sess-1",
		Platform:   "ios",
		Token:      "ExponentPushToken[abc]",
		AccountIDs: []string{"acc-1"},
		Timezone:   "Asia/Hong_Kong",
	}
	if err := s.UpsertPushDevice(d, dek); err != nil {
		t.Fatalf("UpsertPushDevice: %v", err)
	}
	raw := rawCol(t, s, `SELECT token FROM push_devices LIMIT 1`)
	if !strings.HasPrefix(raw, "e1:") {
		t.Fatalf("token column not DEK-wrapped, got %q", raw)
	}
	if strings.Contains(raw, "ExponentPushToken") {
		t.Fatal("plaintext token leaked into DB")
	}

	got, err := s.ListPushDevices("owner@example.com", dek)
	if err != nil {
		t.Fatalf("ListPushDevices: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("len=%d", len(got))
	}
	if got[0].Token != d.Token || got[0].Platform != "ios" || got[0].Timezone != "Asia/Hong_Kong" {
		t.Fatalf("got %+v", got[0])
	}
	if len(got[0].AccountIDs) != 1 || got[0].AccountIDs[0] != "acc-1" {
		t.Fatalf("account ids %+v", got[0].AccountIDs)
	}

	if err := s.DeletePushDevice("owner@example.com", d.Token); err != nil {
		t.Fatalf("DeletePushDevice: %v", err)
	}
	got, _ = s.ListPushDevices("owner@example.com", dek)
	if len(got) != 0 {
		t.Fatalf("expected empty after delete, got %d", len(got))
	}
}

func TestDeviceSessionPersist(t *testing.T) {
	s := newTestStore(t)
	dek := testDEK()
	row := DeviceSession{
		SessionID:    "sid",
		OwnerEmail:   "a@b.c",
		EncDEK:       "opaque-session-secret-wrap",
		LastActiveAt: time.Now().UTC().Truncate(time.Second),
		CreatedAt:    time.Now().UTC().Truncate(time.Second),
	}
	if err := s.UpsertDeviceSession(row, dek); err != nil {
		t.Fatalf("UpsertDeviceSession: %v", err)
	}
	raw := rawCol(t, s, `SELECT owner_email FROM device_sessions LIMIT 1`)
	if !strings.HasPrefix(raw, "e1:") {
		t.Fatalf("owner_email not wrapped: %q", raw)
	}
	encDek := rawCol(t, s, `SELECT enc_dek FROM device_sessions LIMIT 1`)
	if encDek != row.EncDEK {
		t.Fatalf("enc_dek mutated: %q", encDek)
	}

	got, err := s.GetDeviceSession("sid", dek)
	if err != nil || got == nil {
		t.Fatalf("GetDeviceSession: %v %+v", err, got)
	}
	if got.OwnerEmail != "a@b.c" {
		t.Fatalf("email %q", got.OwnerEmail)
	}

	list, err := s.ListDeviceSessions()
	if err != nil || len(list) != 1 {
		t.Fatalf("ListDeviceSessions: %v len=%d", err, len(list))
	}
	if list[0].EncDEK != row.EncDEK {
		t.Fatalf("list enc dek %q", list[0].EncDEK)
	}

	if err := s.DeletePushDevicesBySession("sid"); err != nil {
		t.Fatal(err)
	}
	if err := s.DeleteDeviceSession("sid"); err != nil {
		t.Fatal(err)
	}
	got, err = s.GetDeviceSession("sid", dek)
	if err != nil || got != nil {
		t.Fatalf("expected gone, got %+v err %v", got, err)
	}
}
