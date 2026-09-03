package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/johnwmail/e2mail/backend/internal/api/middleware"
	"github.com/johnwmail/e2mail/backend/internal/config"
	"github.com/johnwmail/e2mail/backend/internal/sieve"
	"github.com/johnwmail/e2mail/backend/internal/storage"
	"github.com/johnwmail/e2mail/backend/pkg/response"
)

// SieveHandler 處理 ManageSieve 相關請求（每帳號獨立）
type SieveHandler struct {
	storage storage.Store
	cfg     *config.ServerConfig
}

// NewSieveHandler 初始化 SieveHandler
func NewSieveHandler(store storage.Store, cfg *config.ServerConfig) *SieveHandler {
	return &SieveHandler{storage: store, cfg: cfg}
}

// resolveSieveConfig 以帳號設定解析實際 ManageSieve 連線參數
func (h *SieveHandler) resolveSieveConfig(acc *storage.Account) sieve.Config {
	host := strings.TrimSpace(acc.SieveHost)
	port := acc.SievePort
	useTLS := acc.SieveUseTLS
	allowInsecure := acc.SieveAllowInsecureTLS

	if host == "" {
		// 優先用全域預設，否則跟隨 IMAP 主機
		if h.cfg != nil && h.cfg.DefaultSieveHost != "" {
			host = h.cfg.DefaultSieveHost
		} else {
			host = acc.IMAPHost
		}
	}
	if port == 0 {
		if h.cfg != nil && h.cfg.DefaultSievePort != 0 {
			port = h.cfg.DefaultSievePort
		} else {
			port = 4190
		}
	}
	// 若帳號未顯式設 sieve TLS，沿用 DefaultSieveUseTLS / DefaultSieveAllowInsecure
	if acc.SieveHost == "" && acc.SievePort == 0 {
		if h.cfg != nil {
			allowInsecure = h.cfg.DefaultSieveAllowInsecureTLS
			// 若全域未設，則跟 IMAP 的 insecure 旗標（兼容自簽環境）
			if !h.cfg.DefaultSieveAllowInsecureTLS && acc.IMAPAllowInsecureTLS {
				allowInsecure = true
			}
		}
		// host 為空時的 UseTLS 由 config 決定，否則保持帳號值（默認 true）
		if h.cfg != nil {
			useTLS = h.cfg.DefaultSieveUseTLS || useTLS
		}
	}
	return sieve.Config{
		Host:             host,
		Port:             port,
		UseTLS:           useTLS,
		AllowInsecureTLS: allowInsecure,
		Username:         acc.Username,
		Password:         "", // 由 caller 填入
		Debug:            h.cfg != nil && h.cfg.SieveDebug,
	}
}

// acquireSieveClient 取得目前帳號的 ManageSieve 連線
func (h *SieveHandler) acquireSieveClient(ctx context.Context, r *http.Request) (*sieve.Client, *middleware.AuthContext, *storage.Account, func(), error) {
	authCtx, acc := middleware.GetCurrentAccount(ctx, r)
	if authCtx == nil || acc == nil {
		return nil, nil, nil, nil, fmt.Errorf("no account available")
	}
	password := middleware.GetCurrentAccountPassword(authCtx, acc)
	if password == "" {
		return nil, nil, nil, nil, fmt.Errorf("failed to decrypt account password")
	}
	cfg := h.resolveSieveConfig(acc)
	cfg.Password = password
	// 若 Username 為空，嘗試 Email
	if cfg.Username == "" {
		cfg.Username = acc.Email
	}
	log.Printf("[SIEVE] dial request account=%s sieveHost=%s:%d useTLS=%v allowInsecure=%v imapHost=%s", acc.ID, cfg.Host, cfg.Port, cfg.UseTLS, cfg.AllowInsecureTLS, acc.IMAPHost)
	client, err := sieve.Dial(ctx, cfg)
	if err != nil {
		log.Printf("[SIEVE] dial failed account=%s host=%s:%d user=%s err=%v", acc.ID, cfg.Host, cfg.Port, cfg.Username, err)
		return nil, nil, nil, nil, err
	}
	log.Printf("[SIEVE] dial success account=%s host=%s:%d", acc.ID, cfg.Host, cfg.Port)
	cleanup := func() { _ = client.Close() }
	return client, authCtx, acc, cleanup, nil
}

// Capability 探測 ManageSieve 能力（用於前端判斷是否支援）
func (h *SieveHandler) Capability(w http.ResponseWriter, r *http.Request) {
	client, _, acc, cleanup, err := h.acquireSieveClient(r.Context(), r)
	if err != nil {
		log.Printf("[SIEVE] capability dial failed account=%s err=%v", accID(acc), err)
		response.InternalServerError(w, "sieve unavailable: "+err.Error())
		return
	}
	defer cleanup()
	caps := client.Capability()
	log.Printf("[SIEVE] capability ok account=%s caps=%v", accID(acc), caps)
	response.Success(w, caps)
}

// ListScripts 列出腳本
func (h *SieveHandler) ListScripts(w http.ResponseWriter, r *http.Request) {
	client, _, acc, cleanup, err := h.acquireSieveClient(r.Context(), r)
	if err != nil {
		log.Printf("[SIEVE] list dial failed account=%s err=%v", accID(acc), err)
		response.InternalServerError(w, "sieve unavailable: "+err.Error())
		return
	}
	defer cleanup()
	scripts, err := client.ListScripts()
	if err != nil {
		log.Printf("[SIEVE] LISTSCRIPTS failed account=%s err=%v", accID(acc), err)
		response.InternalServerError(w, "LISTSCRIPTS failed: "+err.Error())
		return
	}
	if scripts == nil {
		scripts = []sieve.ScriptInfo{}
	}
	log.Printf("[SIEVE] LISTSCRIPTS ok account=%s count=%d", accID(acc), len(scripts))
	response.Success(w, scripts)
}

// GetScript 取得單一腳本內容
func (h *SieveHandler) GetScript(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")
	if name == "" {
		response.BadRequest(w, "script name required")
		return
	}
	client, _, _, cleanup, err := h.acquireSieveClient(r.Context(), r)
	if err != nil {
		response.InternalServerError(w, "sieve unavailable: "+err.Error())
		return
	}
	defer cleanup()
	content, err := client.GetScript(name)
	if err != nil {
		if strings.Contains(err.Error(), "not found") || strings.Contains(strings.ToLower(err.Error()), "does not exist") {
			response.NotFound(w, err.Error())
			return
		}
		response.InternalServerError(w, "GETSCRIPT failed: "+err.Error())
		return
	}
	response.Success(w, map[string]string{"name": name, "content": content})
}

// PutScriptRequest 上傳腳本請求
type PutScriptRequest struct {
	Content string `json:"content"`
}

// PutScript 上傳/覆蓋腳本
func (h *SieveHandler) PutScript(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")
	if name == "" {
		response.BadRequest(w, "script name required")
		return
	}
	var req PutScriptRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		response.BadRequest(w, "invalid json: "+err.Error())
		return
	}
	client, _, _, cleanup, err := h.acquireSieveClient(r.Context(), r)
	if err != nil {
		response.InternalServerError(w, "sieve unavailable: "+err.Error())
		return
	}
	defer cleanup()
	if err := client.PutScript(name, req.Content); err != nil {
		// 語法錯誤等由 Dovecot 返回 NO
		if strings.Contains(err.Error(), "rejected") || strings.Contains(err.Error(), "error") || strings.Contains(strings.ToLower(err.Error()), "failed") {
			// 區分語法錯誤 400 vs 系統錯誤 500
			msg := err.Error()
			if strings.Contains(strings.ToLower(msg), "line") || strings.Contains(strings.ToLower(msg), "syntax") || strings.Contains(strings.ToLower(msg), "parse") {
				response.BadRequest(w, msg)
				return
			}
		}
		response.InternalServerError(w, "PUTSCRIPT failed: "+err.Error())
		return
	}
	log.Printf("[SIEVE] PUTSCRIPT ok name=%s len=%d", name, len(req.Content))
	response.Success(w, map[string]string{"name": name, "message": "script saved"})
}

// DeleteScript 刪除腳本
func (h *SieveHandler) DeleteScript(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")
	if name == "" {
		response.BadRequest(w, "script name required")
		return
	}
	client, _, _, cleanup, err := h.acquireSieveClient(r.Context(), r)
	if err != nil {
		response.InternalServerError(w, "sieve unavailable: "+err.Error())
		return
	}
	defer cleanup()
	if err := client.DeleteScript(name); err != nil {
		response.InternalServerError(w, "DELETESCRIPT failed: "+err.Error())
		return
	}
	log.Printf("[SIEVE] DELETESCRIPT ok name=%s", name)
	response.Success(w, map[string]bool{"deleted": true})
}

// SetActive 設定活動腳本
func (h *SieveHandler) SetActive(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")
	// 允許空字串表示停用全部（DELETE active），但此端點 name 來自 path，需顯式傳空則用 body
	// 為兼容，前端可 POST /scripts/{name}/activate，name 即目標
	if name == "" {
		response.BadRequest(w, "script name required")
		return
	}
	client, _, _, cleanup, err := h.acquireSieveClient(r.Context(), r)
	if err != nil {
		response.InternalServerError(w, "sieve unavailable: "+err.Error())
		return
	}
	defer cleanup()
	if err := client.SetActive(name); err != nil {
		response.InternalServerError(w, "SETACTIVE failed: "+err.Error())
		return
	}
	log.Printf("[SIEVE] SETACTIVE ok name=%s", name)
	response.Success(w, map[string]string{"active": name})
}

// Deactivate 停用全部腳本（SETACTIVE ""）
func (h *SieveHandler) Deactivate(w http.ResponseWriter, r *http.Request) {
	client, _, _, cleanup, err := h.acquireSieveClient(r.Context(), r)
	if err != nil {
		response.InternalServerError(w, "sieve unavailable: "+err.Error())
		return
	}
	defer cleanup()
	if err := client.SetActive(""); err != nil {
		response.InternalServerError(w, "SETACTIVE (deactivate) failed: "+err.Error())
		return
	}
	response.Success(w, map[string]bool{"deactivated": true})
}

// CheckScriptRequest 檢查語法請求
type CheckScriptRequest struct {
	Content string `json:"content"`
}

// CheckScript 檢查語法（不保存）
func (h *SieveHandler) CheckScript(w http.ResponseWriter, r *http.Request) {
	var req CheckScriptRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		response.BadRequest(w, "invalid json: "+err.Error())
		return
	}
	client, _, _, cleanup, err := h.acquireSieveClient(r.Context(), r)
	if err != nil {
		response.InternalServerError(w, "sieve unavailable: "+err.Error())
		return
	}
	defer cleanup()
	if err := client.CheckScript(req.Content); err != nil {
		response.BadRequest(w, err.Error())
		return
	}
	response.Success(w, map[string]string{"message": "script ok"})
}

func accID(acc *storage.Account) string {
	if acc == nil {
		return "?"
	}
	return acc.ID
}
