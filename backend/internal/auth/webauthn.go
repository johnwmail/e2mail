package auth

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sync"
	"time"

	"github.com/go-webauthn/webauthn/protocol"
	"github.com/go-webauthn/webauthn/webauthn"
	"github.com/google/uuid"

	"github.com/johnwmail/e2mail/backend/internal/crypto"
)

// ErrCeremonyNotFound 表示 challenge 唔存在或已過期（Begin 同 Finish 之間）
var ErrCeremonyNotFound = errors.New("webauthn ceremony not found or expired")

// WebAuthnUser 實作 webauthn.User。ID 由 owner email 派生（盲索引），
// 每次重建都一致，確保 session.UserID 對得上。
type WebAuthnUser struct {
	id          []byte
	email       string
	credentials []webauthn.Credential
}

// NewWebAuthnUser 由 email 同已解析嘅憑證清單建立 webauthn.User。
// 憑證可為空（註冊時未有）。
func NewWebAuthnUser(email string, credentials []webauthn.Credential) *WebAuthnUser {
	return &WebAuthnUser{
		id:          []byte(crypto.OwnerID(email)),
		email:       email,
		credentials: credentials,
	}
}

func (u *WebAuthnUser) WebAuthnID() []byte                         { return u.id }
func (u *WebAuthnUser) WebAuthnName() string                       { return u.email }
func (u *WebAuthnUser) WebAuthnDisplayName() string                { return u.email }
func (u *WebAuthnUser) WebAuthnCredentials() []webauthn.Credential { return u.credentials }

// MarshalCredential 將 go-webauthn credential record 序列化成 JSON（存 DB 用）
func MarshalCredential(c *webauthn.Credential) (string, error) {
	if c == nil {
		return "", errors.New("nil credential")
	}
	raw, err := json.Marshal(c)
	if err != nil {
		return "", fmt.Errorf("marshal credential: %w", err)
	}
	return string(raw), nil
}

// ParseCredential 由 DB 內嘅 JSON 還原 go-webauthn credential record
func ParseCredential(raw string) (*webauthn.Credential, error) {
	var c webauthn.Credential
	if err := json.Unmarshal([]byte(raw), &c); err != nil {
		return nil, fmt.Errorf("unmarshal credential: %w", err)
	}
	return &c, nil
}

// WebAuthnService 包住 go-webauthn 實例同 in-flight ceremony store。
// 文檔見 docs/PASSKEY.md。
type WebAuthnService struct {
	wa       *webauthn.WebAuthn
	sessions *ceremonyStore
}

// NewWebAuthnService 依 RP 設定建立 service。origins 必須係完整 origin（含 https://）。
func NewWebAuthnService(rpID, rpName string, origins []string) (*WebAuthnService, error) {
	wa, err := webauthn.New(&webauthn.Config{
		RPID:          rpID,
		RPDisplayName: rpName,
		RPOrigins:     origins,
	})
	if err != nil {
		return nil, fmt.Errorf("webauthn config: %w", err)
	}
	return &WebAuthnService{wa: wa, sessions: newCeremonyStore(5 * time.Minute)}, nil
}

// BeginRegistration 產生註冊選項同 challenge id（存 server-side session）。
func (s *WebAuthnService) BeginRegistration(user *WebAuthnUser) (*protocol.CredentialCreation, string, error) {
	opts := []webauthn.RegistrationOption{
		// touch ID / Face ID / Windows Hello（platform）同 security key（cross-platform）都容許；
		// user verification 用 preferred，等冇 PIN 嘅 security key 一樣可做第二因素。
		webauthn.WithAuthenticatorSelection(protocol.AuthenticatorSelection{
			UserVerification: protocol.VerificationPreferred,
			ResidentKey:      protocol.ResidentKeyRequirementPreferred,
		}),
	}
	creation, session, err := s.wa.BeginRegistration(user, opts...)
	if err != nil {
		return nil, "", fmt.Errorf("begin registration: %w", err)
	}
	return creation, s.sessions.Put(session, ""), nil
}

// FinishRegistration 驗證 attestation，成功回傳新 credential record。
func (s *WebAuthnService) FinishRegistration(user *WebAuthnUser, challengeID string, r *http.Request) (*webauthn.Credential, error) {
	session, _, ok := s.sessions.Take(challengeID)
	if !ok {
		return nil, ErrCeremonyNotFound
	}
	credential, err := s.wa.FinishRegistration(user, *session, r)
	if err != nil {
		return nil, fmt.Errorf("finish registration: %w", err)
	}
	return credential, nil
}

// BeginLogin 產生 assertion 選項（allowCredentials 為該 user 全部憑證）。
// payload 會同 ceremony 一齊暫存，FinishLogin 時原樣取回（用嚟關聯 pending login）。
func (s *WebAuthnService) BeginLogin(user *WebAuthnUser, payload string) (*protocol.CredentialAssertion, string, error) {
	assertion, session, err := s.wa.BeginLogin(user,
		webauthn.WithUserVerification(protocol.VerificationPreferred),
	)
	if err != nil {
		return nil, "", fmt.Errorf("begin login: %w", err)
	}
	return assertion, s.sessions.Put(session, payload), nil
}

// FinishLogin 驗證 assertion，成功回傳更新後嘅 credential（含新 sign count / flags）
// 同 BeginLogin 時傳入嘅 payload。
func (s *WebAuthnService) FinishLogin(user *WebAuthnUser, challengeID string, r *http.Request) (*webauthn.Credential, string, error) {
	session, payload, ok := s.sessions.Take(challengeID)
	if !ok {
		return nil, "", ErrCeremonyNotFound
	}
	credential, err := s.wa.FinishLogin(user, *session, r)
	if err != nil {
		return nil, "", fmt.Errorf("finish login: %w", err)
	}
	return credential, payload, nil
}

// PeekLoginPayload 讀取 ceremony 附帶嘅 payload（唔消耗 ceremony）。
// 登入流程用嚟喺 FinishLogin 之前取回 pending login id 以建立 user。
func (s *WebAuthnService) PeekLoginPayload(challengeID string) (string, bool) {
	return s.sessions.PeekPayload(challengeID)
}

// ceremonyStore 係 in-flight WebAuthn SessionData 嘅記憶體 TTL map。
// 單次使用（Take 後即刪），可附帶一個 opaque payload。
type ceremonyStore struct {
	mu    sync.Mutex
	items map[string]ceremony
	ttl   time.Duration
}

type ceremony struct {
	data    *webauthn.SessionData
	payload string
}

func newCeremonyStore(ttl time.Duration) *ceremonyStore {
	cs := &ceremonyStore{items: make(map[string]ceremony), ttl: ttl}
	go cs.startCleaner()
	return cs
}

func (c *ceremonyStore) Put(s *webauthn.SessionData, payload string) string {
	id := uuid.New().String()
	c.mu.Lock()
	c.items[id] = ceremony{data: s, payload: payload}
	c.mu.Unlock()
	return id
}

func (c *ceremonyStore) Take(id string) (*webauthn.SessionData, string, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	item, ok := c.items[id]
	if !ok {
		return nil, "", false
	}
	delete(c.items, id)
	if !item.data.Expires.IsZero() && time.Now().After(item.data.Expires) {
		return nil, "", false
	}
	return item.data, item.payload, true
}

// PeekPayload 讀取 payload 但唔消耗 ceremony
func (c *ceremonyStore) PeekPayload(id string) (string, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	item, ok := c.items[id]
	if !ok {
		return "", false
	}
	if !item.data.Expires.IsZero() && time.Now().After(item.data.Expires) {
		return "", false
	}
	return item.payload, true
}

func (c *ceremonyStore) startCleaner() {
	ticker := time.NewTicker(c.ttl / 2)
	defer ticker.Stop()
	for range ticker.C {
		now := time.Now()
		c.mu.Lock()
		for id, item := range c.items {
			if !item.data.Expires.IsZero() && now.After(item.data.Expires) {
				delete(c.items, id)
			}
		}
		c.mu.Unlock()
	}
}
