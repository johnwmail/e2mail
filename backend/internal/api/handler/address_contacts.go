package handler

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/mail"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/johnwmail/e2mail/backend/internal/api/middleware"
	"github.com/johnwmail/e2mail/backend/internal/storage"
	"github.com/johnwmail/e2mail/backend/pkg/response"
)

// AddressContactsHandler 通用通訊錄處理（per-user，sqlite contacts 表）
type AddressContactsHandler struct {
	store   storage.Store
	dataDir string
}

func NewAddressContactsHandler(store storage.Store, dataDir string) *AddressContactsHandler {
	return &AddressContactsHandler{store: store, dataDir: dataDir}
}

func (h *AddressContactsHandler) ownerFromCtx(r *http.Request) (string, bool) {
	sess, ok := middleware.GetSessionFromContext(r.Context())
	if !ok || sess.Email == "" {
		return "", false
	}
	return strings.ToLower(strings.TrimSpace(sess.Email)), true
}

// ListAddressContacts GET /api/contacts?q=&limit=&offset=
func (h *AddressContactsHandler) ListAddressContacts(w http.ResponseWriter, r *http.Request) {
	owner, ok := h.ownerFromCtx(r)
	if !ok {
		response.Unauthorized(w, "unauthorized session")
		return
	}
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	offset, _ := strconv.Atoi(r.URL.Query().Get("offset"))
	if limit < 0 {
		limit = 0
	}
	if limit > 200 {
		limit = 200
	}
	if offset < 0 {
		offset = 0
	}
	list, err := h.store.ListAddressContacts(owner, q, limit, offset)
	if err != nil {
		response.InternalServerError(w, "failed to list contacts: "+err.Error())
		return
	}
	response.Success(w, list)
}

// GetAddressContact GET /api/contacts/{id}
func (h *AddressContactsHandler) GetAddressContact(w http.ResponseWriter, r *http.Request) {
	owner, ok := h.ownerFromCtx(r)
	if !ok {
		response.Unauthorized(w, "unauthorized session")
		return
	}
	id := chi.URLParam(r, "id")
	if id == "" {
		response.BadRequest(w, "id is required")
		return
	}
	c, err := h.store.GetAddressContact(owner, id)
	if err != nil {
		response.InternalServerError(w, "failed to get contact: "+err.Error())
		return
	}
	if c == nil {
		response.NotFound(w, "contact not found")
		return
	}
	response.Success(w, c)
}

// CreateAddressContact POST /api/contacts
func (h *AddressContactsHandler) CreateAddressContact(w http.ResponseWriter, r *http.Request) {
	owner, ok := h.ownerFromCtx(r)
	if !ok {
		response.Unauthorized(w, "unauthorized session")
		return
	}
	var req struct {
		Email       string `json:"email"`
		DisplayName string `json:"displayName"`
		GivenName   string `json:"givenName"`
		FamilyName  string `json:"familyName"`
		Note        string `json:"note"`
		Source      string `json:"source"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		response.BadRequest(w, "invalid json body: "+err.Error())
		return
	}
	email := strings.ToLower(strings.TrimSpace(req.Email))
	if email == "" {
		response.BadRequest(w, "email is required")
		return
	}
	if _, err := mail.ParseAddress(email); err != nil {
		// 嘗試完整地址解析
		if _, err2 := mail.ParseAddress(req.Email); err2 != nil {
			response.BadRequest(w, "invalid email: "+err.Error())
			return
		}
	}
	// 檢查每 user 上限 2000
	if cnt, _ := h.store.CountAddressContacts(owner); cnt >= 2000 {
		response.BadRequest(w, "contact limit reached (2000)")
		return
	}
	// 去重：同一 owner+email 已存在則 400
	if exist, _ := h.store.GetAddressContactByEmail(owner, email); exist != nil {
		response.BadRequest(w, "contact already exists for this email")
		return
	}
	c := &storage.Contact{
		ID:          uuid.New().String(),
		OwnerEmail:  owner,
		Email:       email,
		DisplayName: strings.TrimSpace(req.DisplayName),
		GivenName:   strings.TrimSpace(req.GivenName),
		FamilyName:  strings.TrimSpace(req.FamilyName),
		Note:        strings.TrimSpace(req.Note),
		Source:      strings.TrimSpace(req.Source),
	}
	if c.DisplayName == "" {
		c.DisplayName = c.Email
	}
	if err := h.store.CreateAddressContact(c); err != nil {
		response.InternalServerError(w, "failed to create contact: "+err.Error())
		return
	}
	response.Success(w, c)
}

// UpdateAddressContact PUT /api/contacts/{id}
func (h *AddressContactsHandler) UpdateAddressContact(w http.ResponseWriter, r *http.Request) {
	owner, ok := h.ownerFromCtx(r)
	if !ok {
		response.Unauthorized(w, "unauthorized session")
		return
	}
	id := chi.URLParam(r, "id")
	if id == "" {
		response.BadRequest(w, "id is required")
		return
	}
	existing, err := h.store.GetAddressContact(owner, id)
	if err != nil {
		response.InternalServerError(w, "failed to get contact: "+err.Error())
		return
	}
	if existing == nil {
		response.NotFound(w, "contact not found")
		return
	}
	var req struct {
		Email       string `json:"email"`
		DisplayName string `json:"displayName"`
		GivenName   string `json:"givenName"`
		FamilyName  string `json:"familyName"`
		Note        string `json:"note"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		response.BadRequest(w, "invalid json body: "+err.Error())
		return
	}
	if req.Email != "" {
		email := strings.ToLower(strings.TrimSpace(req.Email))
		if _, err := mail.ParseAddress(email); err != nil {
			response.BadRequest(w, "invalid email")
			return
		}
		// 若改 email 需檢查衝突
		if email != existing.Email {
			if dup, _ := h.store.GetAddressContactByEmail(owner, email); dup != nil {
				response.BadRequest(w, "another contact already uses this email")
				return
			}
		}
		existing.Email = email
	}
	if req.DisplayName != "" {
		existing.DisplayName = strings.TrimSpace(req.DisplayName)
	}
	if req.GivenName != "" {
		existing.GivenName = strings.TrimSpace(req.GivenName)
	}
	if req.FamilyName != "" {
		existing.FamilyName = strings.TrimSpace(req.FamilyName)
	}
	if req.Note != "" || r.URL.Query().Get("clearNote") == "1" {
		existing.Note = strings.TrimSpace(req.Note)
	}
	if err := h.store.UpdateAddressContact(existing); err != nil {
		response.InternalServerError(w, "failed to update contact: "+err.Error())
		return
	}
	response.Success(w, existing)
}

// DeleteAddressContact DELETE /api/contacts/{id}
func (h *AddressContactsHandler) DeleteAddressContact(w http.ResponseWriter, r *http.Request) {
	owner, ok := h.ownerFromCtx(r)
	if !ok {
		response.Unauthorized(w, "unauthorized session")
		return
	}
	id := chi.URLParam(r, "id")
	if id == "" {
		response.BadRequest(w, "id is required")
		return
	}
	// 先取以便刪 avatar 檔
	existing, _ := h.store.GetAddressContact(owner, id)
	affected, err := h.store.DeleteAddressContact(owner, id)
	if err != nil {
		response.InternalServerError(w, "failed to delete contact: "+err.Error())
		return
	}
	if affected == 0 {
		response.NotFound(w, "contact not found")
		return
	}
	if existing != nil && existing.AvatarPath != "" {
		_ = os.Remove(filepath.Join(h.dataDir, existing.AvatarPath))
	}
	response.Success(w, map[string]string{"message": "contact deleted"})
}

// CreateFromEmail POST /api/contacts/from-email {email, displayName}
func (h *AddressContactsHandler) CreateFromEmail(w http.ResponseWriter, r *http.Request) {
	owner, ok := h.ownerFromCtx(r)
	if !ok {
		response.Unauthorized(w, "unauthorized session")
		return
	}
	var req struct {
		Email       string `json:"email"`
		DisplayName string `json:"displayName"`
		Note        string `json:"note"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		response.BadRequest(w, "invalid json body: "+err.Error())
		return
	}
	email := strings.ToLower(strings.TrimSpace(req.Email))
	if email == "" {
		response.BadRequest(w, "email is required")
		return
	}
	addr, err := mail.ParseAddress(req.Email)
	if err != nil {
		// 嘗試直接 email
		addr = &mail.Address{Address: email, Name: strings.TrimSpace(req.DisplayName)}
	} else {
		email = strings.ToLower(strings.TrimSpace(addr.Address))
		if addr.Name != "" && strings.TrimSpace(req.DisplayName) == "" {
			req.DisplayName = addr.Name
		}
	}
	if exist, _ := h.store.GetAddressContactByEmail(owner, email); exist != nil {
		response.Success(w, exist)
		return
	}
	if cnt, _ := h.store.CountAddressContacts(owner); cnt >= 2000 {
		response.BadRequest(w, "contact limit reached (2000)")
		return
	}
	c := &storage.Contact{
		ID:          uuid.New().String(),
		OwnerEmail:  owner,
		Email:       email,
		DisplayName: strings.TrimSpace(req.DisplayName),
		Note:        strings.TrimSpace(req.Note),
		Source:      "manual",
	}
	if c.DisplayName == "" {
		if addr != nil && addr.Name != "" {
			c.DisplayName = addr.Name
		} else {
			c.DisplayName = email
		}
	}
	if err := h.store.CreateAddressContact(c); err != nil {
		response.InternalServerError(w, "failed to create contact: "+err.Error())
		return
	}
	response.Success(w, c)
}

// Resolve GET /api/contacts/resolve?emails=a@b.com,c@d.com
func (h *AddressContactsHandler) Resolve(w http.ResponseWriter, r *http.Request) {
	owner, ok := h.ownerFromCtx(r)
	if !ok {
		response.Unauthorized(w, "unauthorized session")
		return
	}
	q := r.URL.Query().Get("emails")
	if q == "" {
		response.Success(w, map[string]any{})
		return
	}
	parts := strings.Split(q, ",")
	emails := make([]string, 0, len(parts))
	for _, p := range parts {
		// 支援 encode
		dec, _ := url.PathUnescape(strings.TrimSpace(p))
		if dec != "" {
			emails = append(emails, dec)
		}
	}
	if len(emails) > 100 {
		emails = emails[:100]
	}
	m, err := h.store.ResolveAddressContacts(owner, emails)
	if err != nil {
		response.InternalServerError(w, "failed to resolve: "+err.Error())
		return
	}
	response.Success(w, m)
}

// Avatar helpers

func avatarDir(dataDir, ownerEmail string) string {
	// 以 owner email hash 避免路徑注入
	safe := strings.ReplaceAll(strings.ToLower(ownerEmail), "@", "_at_")
	safe = strings.ReplaceAll(safe, "/", "_")
	return filepath.Join(dataDir, "avatars", safe)
}

func (h *AddressContactsHandler) GetAvatar(w http.ResponseWriter, r *http.Request) {
	owner, ok := h.ownerFromCtx(r)
	if !ok {
		response.Unauthorized(w, "unauthorized session")
		return
	}
	id := chi.URLParam(r, "id")
	c, err := h.store.GetAddressContact(owner, id)
	if err != nil {
		response.InternalServerError(w, "failed to get contact: "+err.Error())
		return
	}
	if c == nil || c.AvatarPath == "" {
		http.NotFound(w, r)
		return
	}
	fpath := filepath.Join(h.dataDir, c.AvatarPath)
	f, err := os.Open(fpath)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer func() { _ = f.Close() }()
	// 依副檔名猜 content-type
	ext := strings.ToLower(filepath.Ext(fpath))
	ct := "application/octet-stream"
	switch ext {
	case ".jpg", ".jpeg":
		ct = "image/jpeg"
	case ".png":
		ct = "image/png"
	case ".webp":
		ct = "image/webp"
	case ".gif":
		ct = "image/gif"
	}
	w.Header().Set("Content-Type", ct)
	w.Header().Set("Cache-Control", "private, max-age=86400")
	w.Header().Set("ETag", fmt.Sprintf(`"%s-%d"`, c.ID, c.UpdatedAt.Unix()))
	http.ServeContent(w, r, filepath.Base(fpath), c.UpdatedAt, f)
}

func (h *AddressContactsHandler) PutAvatar(w http.ResponseWriter, r *http.Request) {
	owner, ok := h.ownerFromCtx(r)
	if !ok {
		response.Unauthorized(w, "unauthorized session")
		return
	}
	id := chi.URLParam(r, "id")
	c, err := h.store.GetAddressContact(owner, id)
	if err != nil {
		response.InternalServerError(w, "failed to get contact: "+err.Error())
		return
	}
	if c == nil {
		response.NotFound(w, "contact not found")
		return
	}
	// 限 2MB
	r.Body = http.MaxBytesReader(w, r.Body, 2<<20)
	if err := r.ParseMultipartForm(2 << 20); err != nil {
		response.BadRequest(w, "avatar too large (max 2MB) or invalid multipart")
		return
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		// 嘗試 raw body
		file = nil
		if r.Body != nil {
			// 已 ParseMultipartForm 失敗，嘗試直接讀
		}
		response.BadRequest(w, "file field 'file' is required")
		return
	}
	defer func() { _ = file.Close() }()
	// 驗 header 大小
	if header.Size > 2<<20 {
		response.BadRequest(w, "file too large (max 2MB)")
		return
	}
	data, err := io.ReadAll(file)
	if err != nil {
		response.BadRequest(w, "failed to read file: "+err.Error())
		return
	}
	if len(data) == 0 {
		response.BadRequest(w, "empty file")
		return
	}
	// 魔術字節驗證
	ct := http.DetectContentType(data)
	if !(strings.HasPrefix(ct, "image/jpeg") || strings.HasPrefix(ct, "image/png") || strings.HasPrefix(ct, "image/webp") || strings.HasPrefix(ct, "image/gif")) {
		response.BadRequest(w, "only jpg/png/webp/gif allowed, got "+ct)
		return
	}
	ext := ".bin"
	switch {
	case strings.HasPrefix(ct, "image/jpeg"):
		ext = ".jpg"
	case strings.HasPrefix(ct, "image/png"):
		ext = ".png"
	case strings.HasPrefix(ct, "image/webp"):
		ext = ".webp"
	case strings.HasPrefix(ct, "image/gif"):
		ext = ".gif"
	}
	dir := avatarDir(h.dataDir, owner)
	if err := os.MkdirAll(dir, 0700); err != nil {
		response.InternalServerError(w, "failed to create avatar dir: "+err.Error())
		return
	}
	// 刪除舊檔
	if c.AvatarPath != "" {
		_ = os.Remove(filepath.Join(h.dataDir, c.AvatarPath))
	}
	rel := filepath.Join("avatars", strings.ReplaceAll(strings.ToLower(owner), "@", "_at_"), c.ID+ext)
	rel = filepath.ToSlash(rel) // 統一 /
	// 實際路徑用 dir + id.ext
	abs := filepath.Join(dir, c.ID+ext)
	if err := os.WriteFile(abs, data, 0600); err != nil {
		response.InternalServerError(w, "failed to save avatar: "+err.Error())
		return
	}
	c.AvatarPath = rel
	if err := h.store.UpdateAddressContact(c); err != nil {
		response.InternalServerError(w, "failed to update contact avatar: "+err.Error())
		return
	}
	response.Success(w, c)
}

func (h *AddressContactsHandler) DeleteAvatar(w http.ResponseWriter, r *http.Request) {
	owner, ok := h.ownerFromCtx(r)
	if !ok {
		response.Unauthorized(w, "unauthorized session")
		return
	}
	id := chi.URLParam(r, "id")
	c, err := h.store.GetAddressContact(owner, id)
	if err != nil {
		response.InternalServerError(w, "failed to get contact: "+err.Error())
		return
	}
	if c == nil {
		response.NotFound(w, "contact not found")
		return
	}
	if c.AvatarPath != "" {
		_ = os.Remove(filepath.Join(h.dataDir, c.AvatarPath))
		c.AvatarPath = ""
		_ = h.store.UpdateAddressContact(c)
	}
	response.Success(w, map[string]string{"message": "avatar deleted"})
}
