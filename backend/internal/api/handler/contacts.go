package handler

import (
	"encoding/json"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"modern-webmail/backend/internal/api/middleware"
	"modern-webmail/backend/internal/storage"
	"modern-webmail/backend/pkg/response"
)

// ContactKeyDTO 對外 API 格式（與前端 PgpContactKey 對齊）
type ContactKeyDTO struct {
	Email           string `json:"email"`
	Name            string `json:"name,omitempty"`
	PublicKeyArmored string `json:"publicKeyArmored"`
	Fingerprint    string `json:"fingerprint"`
	KeyID          string `json:"keyId,omitempty"`
	CreatedAt      time.Time `json:"createdAt"`
}

func toDTO(c storage.ContactKey) ContactKeyDTO {
	return ContactKeyDTO{
		Email:           c.ContactEmail,
		Name:            c.Name,
		PublicKeyArmored: c.ArmoredKey,
		Fingerprint:    c.Fingerprint,
		KeyID:          c.KeyID,
		CreatedAt:      c.CreatedAt,
	}
}

func fromDTO(ownerEmail string, d ContactKeyDTO) (storage.ContactKey, error) {
	email := strings.ToLower(strings.TrimSpace(d.Email))
	if email == "" {
		return storage.ContactKey{}, errInvalidEmail
	}
	if strings.TrimSpace(d.PublicKeyArmored) == "" {
		return storage.ContactKey{}, errInvalidArmoredKey
	}
	if strings.TrimSpace(d.Fingerprint) == "" {
		return storage.ContactKey{}, errInvalidFingerprint
	}
	c := storage.ContactKey{
		OwnerEmail:   ownerEmail,
		ContactEmail: email,
		Name:         strings.TrimSpace(d.Name),
		Fingerprint:  strings.ToUpper(strings.TrimSpace(d.Fingerprint)),
		KeyID:        strings.ToUpper(strings.TrimSpace(d.KeyID)),
		ArmoredKey:   d.PublicKeyArmored,
	}
	if !d.CreatedAt.IsZero() {
		c.CreatedAt = d.CreatedAt.UTC()
	}
	return c, nil
}

var (
	errInvalidEmail      = validationError("email is required")
	errInvalidArmoredKey = validationError("publicKeyArmored is required")
	errInvalidFingerprint = validationError("fingerprint is required")
)

type validationError string

func (e validationError) Error() string { return string(e) }

// ContactsHandler 處理聯絡人公鑰之 CRUD（per-user，以會話 Email 為擁有者）
type ContactsHandler struct {
	store storage.Store
}

func NewContactsHandler(store storage.Store) *ContactsHandler {
	return &ContactsHandler{store: store}
}

func (h *ContactsHandler) ownerFromCtx(r *http.Request) (string, bool) {
	sess, ok := middleware.GetSessionFromContext(r.Context())
	if !ok || sess.Email == "" {
		return "", false
	}
	return strings.ToLower(strings.TrimSpace(sess.Email)), true
}

// ListContacts 取得目前登入使用者之所有聯絡人
func (h *ContactsHandler) ListContacts(w http.ResponseWriter, r *http.Request) {
	owner, ok := h.ownerFromCtx(r)
	if !ok {
		response.Unauthorized(w, "unauthorized session")
		return
	}
	contacts, err := h.store.ListContacts(owner)
	if err != nil {
		response.InternalServerError(w, "failed to list contacts: "+err.Error())
		return
	}
	out := make([]ContactKeyDTO, 0, len(contacts))
	for _, c := range contacts {
		out = append(out, toDTO(c))
	}
	response.Success(w, out)
}

// UpsertContact 新增或更新單一聯絡人
func (h *ContactsHandler) UpsertContact(w http.ResponseWriter, r *http.Request) {
	owner, ok := h.ownerFromCtx(r)
	if !ok {
		response.Unauthorized(w, "unauthorized session")
		return
	}
	var dto ContactKeyDTO
	if err := json.NewDecoder(r.Body).Decode(&dto); err != nil {
		response.BadRequest(w, "invalid json body: "+err.Error())
		return
	}
	contact, err := fromDTO(owner, dto)
	if err != nil {
		response.BadRequest(w, err.Error())
		return
	}
	if err := h.store.UpsertContact(contact); err != nil {
		response.InternalServerError(w, "failed to save contact: "+err.Error())
		return
	}
	response.Success(w, map[string]any{
		"message": "contact saved",
		"contact": toDTO(contact),
	})
}

// BulkUpsertContacts 批次匯入聯絡人（已存在者略過）
func (h *ContactsHandler) BulkUpsertContacts(w http.ResponseWriter, r *http.Request) {
	owner, ok := h.ownerFromCtx(r)
	if !ok {
		response.Unauthorized(w, "unauthorized session")
		return
	}
	var req struct {
		Contacts []ContactKeyDTO `json:"contacts"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		response.BadRequest(w, "invalid json body: "+err.Error())
		return
	}
	if len(req.Contacts) == 0 {
		response.Success(w, map[string]any{"saved": 0, "skipped": []string{}})
		return
	}

	contacts := make([]storage.ContactKey, 0, len(req.Contacts))
	invalid := 0
	for _, dto := range req.Contacts {
		c, err := fromDTO(owner, dto)
		if err != nil {
			invalid++
			continue
		}
		contacts = append(contacts, c)
	}
	saved, skipped, err := h.store.BulkUpsertContacts(owner, contacts)
	if err != nil {
		response.InternalServerError(w, "failed to bulk save contacts: "+err.Error())
		return
	}
	response.Success(w, map[string]any{
		"saved":   saved,
		"skipped": skipped,
		"invalid": invalid,
	})
}

// DeleteContact 刪除單一聯絡人
func (h *ContactsHandler) DeleteContact(w http.ResponseWriter, r *http.Request) {
	owner, ok := h.ownerFromCtx(r)
	if !ok {
		response.Unauthorized(w, "unauthorized session")
		return
	}
	email := strings.ToLower(strings.TrimSpace(chi.URLParam(r, "email")))
	if email == "" {
		response.BadRequest(w, "email is required")
		return
	}
	log.Printf("[DELETE CONTACT] owner=%q email=%q", owner, email)
	affected, err := h.store.DeleteContact(owner, email)
	if err != nil {
		response.InternalServerError(w, "failed to delete contact: "+err.Error())
		return
	}
	log.Printf("[DELETE CONTACT] owner=%q email=%q affected=%d", owner, email, affected)
	response.Success(w, map[string]string{"message": "contact deleted"})
}
