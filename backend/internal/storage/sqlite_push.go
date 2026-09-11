package storage

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/johnwmail/e2mail/backend/internal/crypto"
)

// DeviceSession 持久化裝置會話。EncDEK 係 SESSION_SECRET 包住嘅 DEK（同 RAM session 一樣），
// OwnerEmail 則用用戶 DEK 加密落盤。
type DeviceSession struct {
	SessionID    string
	OwnerEmail   string
	EncDEK       string
	LastActiveAt time.Time
	CreatedAt    time.Time
}

// PushDevice 已登記嘅推播裝置（struct 為明文視圖）。
type PushDevice struct {
	TokenHash  string
	OwnerEmail string
	SessionID  string
	Platform   string
	Token      string
	AccountIDs []string
	Timezone   string
	CreatedAt  time.Time
	UpdatedAt  time.Time
}

func (s *SQLiteStore) UpsertDeviceSession(row DeviceSession, dek []byte) error {
	if row.SessionID == "" || row.OwnerEmail == "" || row.EncDEK == "" {
		return errors.New("session id, owner email, and enc dek are required")
	}
	encEmail, err := crypto.WrapField(dek, row.OwnerEmail)
	if err != nil {
		return err
	}
	now := time.Now().UTC()
	if row.CreatedAt.IsZero() {
		row.CreatedAt = now
	}
	if row.LastActiveAt.IsZero() {
		row.LastActiveAt = now
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err = s.db.Exec(
		`INSERT INTO device_sessions (session_id, owner_id, enc_dek, owner_email, last_active_at, created_at)
		 VALUES (?, ?, ?, ?, ?, ?)
		 ON CONFLICT(session_id) DO UPDATE SET
		   owner_id = excluded.owner_id,
		   enc_dek = excluded.enc_dek,
		   owner_email = excluded.owner_email,
		   last_active_at = excluded.last_active_at`,
		row.SessionID, crypto.OwnerID(row.OwnerEmail), row.EncDEK, encEmail,
		row.LastActiveAt.Unix(), row.CreatedAt.Unix(),
	)
	if err != nil {
		return fmt.Errorf("upsert device session: %w", err)
	}
	return nil
}

func (s *SQLiteStore) GetDeviceSession(sessionID string, dek []byte) (*DeviceSession, error) {
	var row DeviceSession
	var ownerEmailEnc string
	var last, created int64
	err := s.db.QueryRow(
		`SELECT session_id, enc_dek, owner_email, last_active_at, created_at FROM device_sessions WHERE session_id = ?`,
		sessionID,
	).Scan(&row.SessionID, &row.EncDEK, &ownerEmailEnc, &last, &created)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get device session: %w", err)
	}
	email, err := crypto.UnwrapField(dek, ownerEmailEnc)
	if err != nil {
		return nil, err
	}
	row.OwnerEmail = email
	row.LastActiveAt = time.Unix(last, 0).UTC()
	row.CreatedAt = time.Unix(created, 0).UTC()
	return &row, nil
}

func (s *SQLiteStore) ListDeviceSessions() ([]DeviceSession, error) {
	rows, err := s.db.Query(`SELECT session_id, enc_dek, owner_email, last_active_at, created_at FROM device_sessions`)
	if err != nil {
		return nil, fmt.Errorf("list device sessions: %w", err)
	}
	defer func() { _ = rows.Close() }()
	var out []DeviceSession
	for rows.Next() {
		var row DeviceSession
		var ownerEmailEnc string
		var last, created int64
		if err := rows.Scan(&row.SessionID, &row.EncDEK, &ownerEmailEnc, &last, &created); err != nil {
			return nil, err
		}
		row.OwnerEmail = ownerEmailEnc // still wrapped; restore path decrypts DEK first
		row.LastActiveAt = time.Unix(last, 0).UTC()
		row.CreatedAt = time.Unix(created, 0).UTC()
		out = append(out, row)
	}
	return out, rows.Err()
}

func (s *SQLiteStore) DeleteDeviceSession(sessionID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.Exec(`DELETE FROM device_sessions WHERE session_id = ?`, sessionID)
	if err != nil {
		return fmt.Errorf("delete device session: %w", err)
	}
	return nil
}

func (s *SQLiteStore) TouchDeviceSession(sessionID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.Exec(`UPDATE device_sessions SET last_active_at = ? WHERE session_id = ?`, time.Now().UTC().Unix(), sessionID)
	if err != nil {
		return fmt.Errorf("touch device session: %w", err)
	}
	return nil
}

func (s *SQLiteStore) UpsertPushDevice(d PushDevice, dek []byte) error {
	if d.OwnerEmail == "" || d.Token == "" || d.SessionID == "" {
		return errors.New("owner email, token, and session id are required")
	}
	if d.Platform == "" {
		d.Platform = "unknown"
	}
	if d.AccountIDs == nil {
		d.AccountIDs = []string{}
	}
	idsJSON, err := json.Marshal(d.AccountIDs)
	if err != nil {
		return err
	}
	encToken, err := crypto.WrapField(dek, d.Token)
	if err != nil {
		return err
	}
	encIDs, err := crypto.WrapField(dek, string(idsJSON))
	if err != nil {
		return err
	}
	encTZ, err := crypto.WrapField(dek, d.Timezone)
	if err != nil {
		return err
	}
	now := time.Now().UTC()
	if d.CreatedAt.IsZero() {
		d.CreatedAt = now
	}
	d.UpdatedAt = now
	hash := crypto.HashID(d.Token)
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err = s.db.Exec(
		`INSERT INTO push_devices (token_hash, owner_id, session_id, platform, token, account_ids, timezone, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(token_hash) DO UPDATE SET
		   owner_id = excluded.owner_id,
		   session_id = excluded.session_id,
		   platform = excluded.platform,
		   token = excluded.token,
		   account_ids = excluded.account_ids,
		   timezone = excluded.timezone,
		   updated_at = excluded.updated_at`,
		hash, crypto.OwnerID(d.OwnerEmail), d.SessionID, d.Platform, encToken, encIDs, encTZ,
		d.CreatedAt.Unix(), d.UpdatedAt.Unix(),
	)
	if err != nil {
		return fmt.Errorf("upsert push device: %w", err)
	}
	return nil
}

func scanPushDevice(dek []byte, ownerEmail, sessionID, platform, encToken, encIDs, encTZ string, created, updated int64, hash string) (PushDevice, error) {
	token, err := crypto.UnwrapField(dek, encToken)
	if err != nil {
		return PushDevice{}, err
	}
	idsRaw, err := crypto.UnwrapField(dek, encIDs)
	if err != nil {
		return PushDevice{}, err
	}
	tz, err := crypto.UnwrapField(dek, encTZ)
	if err != nil {
		return PushDevice{}, err
	}
	var ids []string
	if idsRaw != "" {
		if err := json.Unmarshal([]byte(idsRaw), &ids); err != nil {
			ids = nil
		}
	}
	return PushDevice{
		TokenHash:  hash,
		OwnerEmail: ownerEmail,
		SessionID:  sessionID,
		Platform:   platform,
		Token:      token,
		AccountIDs: ids,
		Timezone:   tz,
		CreatedAt:  time.Unix(created, 0).UTC(),
		UpdatedAt:  time.Unix(updated, 0).UTC(),
	}, nil
}

func (s *SQLiteStore) ListPushDevices(ownerEmail string, dek []byte) ([]PushDevice, error) {
	rows, err := s.db.Query(
		`SELECT token_hash, session_id, platform, token, account_ids, timezone, created_at, updated_at
		 FROM push_devices WHERE owner_id = ?`,
		crypto.OwnerID(ownerEmail),
	)
	if err != nil {
		return nil, fmt.Errorf("list push devices: %w", err)
	}
	defer func() { _ = rows.Close() }()
	var out []PushDevice
	for rows.Next() {
		var hash, sessionID, platform, encToken, encIDs, encTZ string
		var created, updated int64
		if err := rows.Scan(&hash, &sessionID, &platform, &encToken, &encIDs, &encTZ, &created, &updated); err != nil {
			return nil, err
		}
		d, err := scanPushDevice(dek, ownerEmail, sessionID, platform, encToken, encIDs, encTZ, created, updated, hash)
		if err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

func (s *SQLiteStore) GetPushDeviceByToken(token string, dek []byte) (*PushDevice, error) {
	var hash, ownerID, sessionID, platform, encToken, encIDs, encTZ string
	var created, updated int64
	err := s.db.QueryRow(
		`SELECT token_hash, owner_id, session_id, platform, token, account_ids, timezone, created_at, updated_at
		 FROM push_devices WHERE token_hash = ?`,
		crypto.HashID(token),
	).Scan(&hash, &ownerID, &sessionID, &platform, &encToken, &encIDs, &encTZ, &created, &updated)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get push device: %w", err)
	}
	d, err := scanPushDevice(dek, "", sessionID, platform, encToken, encIDs, encTZ, created, updated, hash)
	if err != nil {
		return nil, err
	}
	return &d, nil
}

func (s *SQLiteStore) DeletePushDevice(ownerEmail, token string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.Exec(
		`DELETE FROM push_devices WHERE owner_id = ? AND token_hash = ?`,
		crypto.OwnerID(ownerEmail), crypto.HashID(token),
	)
	if err != nil {
		return fmt.Errorf("delete push device: %w", err)
	}
	return nil
}

func (s *SQLiteStore) DeletePushDevicesBySession(sessionID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.Exec(`DELETE FROM push_devices WHERE session_id = ?`, sessionID)
	if err != nil {
		return fmt.Errorf("delete push devices by session: %w", err)
	}
	return nil
}
