package handler

import (
	"encoding/json"
	"net/http"
	"net/url"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/johnwmail/e2mail/backend/internal/api/middleware"
	"github.com/johnwmail/e2mail/backend/internal/imap"
	"github.com/johnwmail/e2mail/backend/internal/push"
	"github.com/johnwmail/e2mail/backend/internal/session"
	"github.com/johnwmail/e2mail/backend/internal/storage"
	"github.com/johnwmail/e2mail/backend/pkg/response"
)

// PushHandler 裝置 token 登記。
type PushHandler struct {
	db      storage.Store
	sess    session.Store
	idleMgr *imap.IdleManager
}

func NewPushHandler(db storage.Store, sess session.Store, idleMgr *imap.IdleManager) *PushHandler {
	return &PushHandler{db: db, sess: sess, idleMgr: idleMgr}
}

type registerPushRequest struct {
	Token      string   `json:"token"`
	Platform   string   `json:"platform"`
	AccountIDs []string `json:"accountIds"`
	Timezone   string   `json:"timezone"`
}

type pushDeviceDTO struct {
	Platform   string   `json:"platform"`
	AccountIDs []string `json:"accountIds"`
	Timezone   string   `json:"timezone"`
	CreatedAt  string   `json:"createdAt"`
}

func (h *PushHandler) Register(w http.ResponseWriter, r *http.Request) {
	sess, authCtx, ok := h.auth(w, r)
	if !ok {
		return
	}
	var req registerPushRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		response.BadRequest(w, "invalid json body: "+err.Error())
		return
	}
	token := strings.TrimSpace(req.Token)
	if token == "" || len(token) > 4096 {
		response.BadRequest(w, "token required")
		return
	}
	platform := strings.ToLower(strings.TrimSpace(req.Platform))
	switch platform {
	case "ios", "android", "web":
	default:
		response.BadRequest(w, "platform must be ios, android, or web")
		return
	}

	if err := h.db.UpsertPushDevice(storage.PushDevice{
		OwnerEmail: sess.Email,
		SessionID:  sess.ID,
		Platform:   platform,
		Token:      token,
		AccountIDs: req.AccountIDs,
		Timezone:   strings.TrimSpace(req.Timezone),
	}, authCtx.DEK); err != nil {
		response.InternalServerError(w, "failed to save device: "+err.Error())
		return
	}
	if err := h.db.UpsertDeviceSession(storage.DeviceSession{
		SessionID:    sess.ID,
		OwnerEmail:   sess.Email,
		EncDEK:       sess.EncryptedDEK,
		LastActiveAt: sess.LastActiveAt,
		CreatedAt:    sess.CreatedAt,
	}, authCtx.DEK); err != nil {
		response.InternalServerError(w, "failed to persist device session: "+err.Error())
		return
	}
	push.StartIdleForSession(h.idleMgr, sess, authCtx.DEK)
	response.Success(w, map[string]any{"registered": true, "platform": platform})
}

func (h *PushHandler) List(w http.ResponseWriter, r *http.Request) {
	sess, authCtx, ok := h.auth(w, r)
	if !ok {
		return
	}
	devices, err := h.db.ListPushDevices(sess.Email, authCtx.DEK)
	if err != nil {
		response.InternalServerError(w, "failed to list devices: "+err.Error())
		return
	}
	out := make([]pushDeviceDTO, 0, len(devices))
	for _, d := range devices {
		out = append(out, pushDeviceDTO{
			Platform:   d.Platform,
			AccountIDs: d.AccountIDs,
			Timezone:   d.Timezone,
			CreatedAt:  d.CreatedAt.Format("2006-01-02T15:04:05Z"),
		})
	}
	response.Success(w, out)
}

func (h *PushHandler) Unregister(w http.ResponseWriter, r *http.Request) {
	sess, _, ok := h.auth(w, r)
	if !ok {
		return
	}
	raw, err := url.PathUnescape(chi.URLParam(r, "token"))
	if err != nil {
		raw = chi.URLParam(r, "token")
	}
	token := strings.TrimSpace(raw)
	if token == "" {
		response.BadRequest(w, "token required")
		return
	}
	if err := h.db.DeletePushDevice(sess.Email, token); err != nil {
		response.InternalServerError(w, "failed to delete device: "+err.Error())
		return
	}
	response.Success(w, map[string]bool{"deleted": true})
}

func (h *PushHandler) auth(w http.ResponseWriter, r *http.Request) (*session.Session, *middleware.AuthContext, bool) {
	sess, ok := middleware.GetSessionFromContext(r.Context())
	if !ok || sess == nil || sess.Email == "" {
		response.Unauthorized(w, "unauthorized session")
		return nil, nil, false
	}
	authCtx := middleware.GetAccountContext(r.Context())
	if authCtx == nil || len(authCtx.DEK) == 0 {
		response.Unauthorized(w, "unauthorized session")
		return nil, nil, false
	}
	return sess, authCtx, true
}
