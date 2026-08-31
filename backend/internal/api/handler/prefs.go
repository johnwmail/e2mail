package handler

import (
	"encoding/json"
	"net/http"
	"regexp"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/johnwmail/e2mail/backend/internal/api/middleware"
	"github.com/johnwmail/e2mail/backend/internal/storage"
	"github.com/johnwmail/e2mail/backend/pkg/response"
)

// PrefsHandler per-user 通用設定（key-value），例如 thread 模式開/關
type PrefsHandler struct {
	store storage.Store
}

func NewPrefsHandler(store storage.Store) *PrefsHandler {
	return &PrefsHandler{store: store}
}

var prefKeyRe = regexp.MustCompile(`^[a-zA-Z][a-zA-Z0-9_-]{0,63}$`)

func (h *PrefsHandler) ownerFromCtx(r *http.Request) (string, bool) {
	sess, ok := middleware.GetSessionFromContext(r.Context())
	if !ok || sess.Email == "" {
		return "", false
	}
	return strings.ToLower(strings.TrimSpace(sess.Email)), true
}

// GetPref GET /api/prefs/{key}
func (h *PrefsHandler) GetPref(w http.ResponseWriter, r *http.Request) {
	owner, ok := h.ownerFromCtx(r)
	if !ok {
		response.Unauthorized(w, "unauthorized session")
		return
	}
	key := chi.URLParam(r, "key")
	if !prefKeyRe.MatchString(key) {
		response.BadRequest(w, "invalid pref key")
		return
	}
	val, err := h.store.GetUserPref(owner, key)
	if err != nil {
		response.InternalServerError(w, "failed to get pref: "+err.Error())
		return
	}
	response.Success(w, map[string]string{"key": key, "value": val})
}

// SetPref PUT /api/prefs/{key} body {"value":"..."}
func (h *PrefsHandler) SetPref(w http.ResponseWriter, r *http.Request) {
	owner, ok := h.ownerFromCtx(r)
	if !ok {
		response.Unauthorized(w, "unauthorized session")
		return
	}
	key := chi.URLParam(r, "key")
	if !prefKeyRe.MatchString(key) {
		response.BadRequest(w, "invalid pref key")
		return
	}
	var req struct {
		Value string `json:"value"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		response.BadRequest(w, "invalid json body: "+err.Error())
		return
	}
	if err := h.store.SetUserPref(owner, key, req.Value); err != nil {
		response.InternalServerError(w, "failed to set pref: "+err.Error())
		return
	}
	response.Success(w, map[string]string{"key": key, "value": req.Value})
}
