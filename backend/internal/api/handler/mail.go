package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/emersion/go-imap/v2"
	"github.com/go-chi/chi/v5"
	"github.com/johnwmail/e2mail/backend/internal/api/middleware"
	imapinternal "github.com/johnwmail/e2mail/backend/internal/imap"
	"github.com/johnwmail/e2mail/backend/internal/smtp"
	"github.com/johnwmail/e2mail/backend/internal/storage"
	"github.com/johnwmail/e2mail/backend/pkg/response"
)

// acquireClient 取得目前帳號嘅 IMAP 連線（account 參數缺省用 default）
func (h *MailHandler) acquireClient(ctx context.Context, r *http.Request) (*imapinternal.Client, func(), *middleware.AuthContext, *storage.Account, error) {
	authCtx, acc := middleware.GetCurrentAccount(ctx, r)
	if authCtx == nil || acc == nil {
		return nil, nil, nil, nil, fmt.Errorf("no account available")
	}
	password := middleware.GetCurrentAccountPassword(authCtx, acc)
	if password == "" {
		return nil, nil, nil, nil, fmt.Errorf("failed to decrypt account password")
	}
	config := imapinternal.ConnectionConfig{
		Host:             acc.IMAPHost,
		Port:             acc.IMAPPort,
		UseTLS:           acc.IMAPUseTLS,
		AllowInsecureTLS: acc.IMAPAllowInsecureTLS,
		Username:         acc.Username,
		Password:         password,
	}
	client, release, err := h.poolMgr.GetClient(ctx, authCtx.Session.ID, acc.ID, config)
	if err != nil {
		return nil, nil, nil, nil, err
	}
	return client, release, authCtx, acc, nil
}

// MailHandler 處理郵件與信箱相關請求
type MailHandler struct {
	poolMgr *imapinternal.PoolManager
	sender  *smtp.Sender
}

// NewMailHandler 初始化 MailHandler
func NewMailHandler(poolMgr *imapinternal.PoolManager, sender *smtp.Sender) *MailHandler {
	return &MailHandler{
		poolMgr: poolMgr,
		sender:  sender,
	}
}

// SetFolderSubscription 訂閱／取消訂閱 IMAP 資料夾
func (h *MailHandler) SetFolderSubscription(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name       string `json:"name"`
		Subscribed bool   `json:"subscribed"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		response.BadRequest(w, "invalid json payload: "+err.Error())
		return
	}
	if req.Name == "" {
		response.BadRequest(w, "folder name is required")
		return
	}
	if strings.EqualFold(req.Name, "INBOX") {
		response.BadRequest(w, "INBOX cannot be unsubscribed")
		return
	}

	client, release, _, _, err := h.acquireClient(r.Context(), r)
	if err != nil {
		response.InternalServerError(w, "failed to get IMAP connection: "+err.Error())
		return
	}
	defer release()

	if req.Subscribed {
		if err := client.SubscribeFolder(r.Context(), req.Name); err != nil {
			response.InternalServerError(w, err.Error())
			return
		}
	} else {
		if err := client.UnsubscribeFolder(r.Context(), req.Name); err != nil {
			response.InternalServerError(w, err.Error())
			return
		}
	}

	log.Printf("[FOLDER] %s %s", map[bool]string{true: "subscribed", false: "unsubscribed"}[req.Subscribed], req.Name)
	response.Success(w, map[string]bool{"subscribed": req.Subscribed})
}

// ListFolders 取得使用者所有資料夾與未讀數
func (h *MailHandler) ListFolders(w http.ResponseWriter, r *http.Request) {
	client, release, _, _, err := h.acquireClient(r.Context(), r)
	if err != nil {
		response.InternalServerError(w, "failed to get IMAP connection: "+err.Error())
		return
	}
	defer release()

	folders, err := client.ListFolders(r.Context())
	if err != nil {
		response.InternalServerError(w, "failed to list folders: "+err.Error())
		return
	}

	response.Success(w, folders)
}

// ListMessages 分頁取得指定資料夾的信件清單
func (h *MailHandler) ListMessages(w http.ResponseWriter, r *http.Request) {
	folder := r.URL.Query().Get("folder")
	if folder == "" {
		folder = "INBOX"
	}

	page := 1
	if pStr := r.URL.Query().Get("page"); pStr != "" {
		if p, err := strconv.Atoi(pStr); err == nil && p > 0 {
			page = p
		}
	}

	limit := 50
	if lStr := r.URL.Query().Get("limit"); lStr != "" {
		if l, err := strconv.Atoi(lStr); err == nil && l > 0 && l <= 100 {
			limit = l
		}
	}

	query := r.URL.Query().Get("q")

	client, release, _, _, err := h.acquireClient(r.Context(), r)
	if err != nil {
		response.InternalServerError(w, "failed to get IMAP connection: "+err.Error())
		return
	}
	defer release()

	result, err := client.FetchMessageSummaries(r.Context(), folder, page, limit, query)
	if err != nil {
		response.InternalServerError(w, "failed to fetch messages: "+err.Error())
		return
	}

	response.Success(w, result)
}

// GetMessageDetail 讀取特定 UID 的完整郵件內文與附件結構
func (h *MailHandler) GetMessageDetail(w http.ResponseWriter, r *http.Request) {
	uidStr := chi.URLParam(r, "uid")
	uid64, err := strconv.ParseUint(uidStr, 10, 32)
	if err != nil {
		response.BadRequest(w, "invalid message UID")
		return
	}

	folder := r.URL.Query().Get("folder")
	if folder == "" {
		folder = "INBOX"
	}

	client, release, _, _, err := h.acquireClient(r.Context(), r)
	if err != nil {
		response.InternalServerError(w, "failed to get IMAP connection: "+err.Error())
		return
	}
	defer release()

	msg, err := client.FetchMessageDetail(r.Context(), folder, uint32(uid64))
	if err != nil {
		response.NotFound(w, "message not found or failed to parse: "+err.Error())
		return
	}

	// 自動標記為已讀
	if msg.Unread {
		if err := client.SetFlags(r.Context(), folder, []uint32{uint32(uid64)}, []string{`\Seen`}, "add"); err != nil {
			log.Printf("[MAIL] auto-mark seen FAILED for uid=%d folder=%s: %v", uid64, folder, err)
		} else {
			log.Printf("[MAIL] auto-mark seen OK for uid=%d folder=%s", uid64, folder)
		}
		msg.Unread = false
	}

	response.Success(w, msg)
}

// GetRawMessage 取得指定郵件嘅原始 RFC822 來源（View Source 用）
func (h *MailHandler) GetRawMessage(w http.ResponseWriter, r *http.Request) {
	uidStr := chi.URLParam(r, "uid")
	uid64, err := strconv.ParseUint(uidStr, 10, 32)
	if err != nil {
		response.BadRequest(w, "invalid message UID")
		return
	}
	folder := r.URL.Query().Get("folder")
	if folder == "" {
		folder = "INBOX"
	}
	client, release, _, _, err := h.acquireClient(r.Context(), r)
	if err != nil {
		response.InternalServerError(w, "failed to get IMAP connection: "+err.Error())
		return
	}
	defer release()

	raw, err := client.FetchRawMessage(r.Context(), folder, uint32(uid64))
	if err != nil {
		response.NotFound(w, "message not found: "+err.Error())
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Content-Disposition", fmt.Sprintf("inline; filename=\"%d.eml\"", uid64))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(raw)
}

// DownloadAttachment 下載或預覽指定郵件中的附件檔案
func (h *MailHandler) DownloadAttachment(w http.ResponseWriter, r *http.Request) {
	uidStr := chi.URLParam(r, "uid")
	attID := chi.URLParam(r, "attId")
	uid64, err := strconv.ParseUint(uidStr, 10, 32)
	if err != nil {
		response.BadRequest(w, "invalid message UID")
		return
	}

	folder := r.URL.Query().Get("folder")
	if folder == "" {
		folder = "INBOX"
	}

	client, release, _, _, err := h.acquireClient(r.Context(), r)
	if err != nil {
		response.InternalServerError(w, "failed to get IMAP connection: "+err.Error())
		return
	}
	defer release()

	msg, err := client.FetchMessageDetail(r.Context(), folder, uint32(uid64))
	if err != nil {
		response.NotFound(w, "message not found: "+err.Error())
		return
	}

	var targetAtt *imapinternal.AttachmentInfo
	for _, a := range msg.Attachments {
		if a.ID == attID || a.ContentID == attID {
			targetAtt = &a
			break
		}
	}

	if targetAtt == nil {
		response.NotFound(w, "attachment not found")
		return
	}

	contentType := targetAtt.ContentType
	if contentType == "" {
		contentType = "application/octet-stream"
	}

	w.Header().Set("Content-Type", contentType)
	if targetAtt.IsInline {
		w.Header().Set("Content-Disposition", fmt.Sprintf("inline; filename=%q", targetAtt.Filename))
	} else {
		w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", targetAtt.Filename))
	}
	w.Header().Set("Content-Length", strconv.Itoa(len(targetAtt.Data)))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(targetAtt.Data)
}

// FlagsRequest 批次修改 Flag 請求
type FlagsRequest struct {
	Folder string   `json:"folder"`
	UIDs   []uint32 `json:"uids"`
	Flags  []string `json:"flags"`
	Op     string   `json:"op"` // "add", "remove", "set"
}

// SetFlags 批次修改已讀、未讀、星標等 Flag
func (h *MailHandler) SetFlags(w http.ResponseWriter, r *http.Request) {
	var req FlagsRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		response.BadRequest(w, "invalid request body")
		return
	}

	if req.Folder == "" {
		req.Folder = "INBOX"
	}
	if len(req.UIDs) == 0 || len(req.Flags) == 0 {
		response.BadRequest(w, "uids and flags cannot be empty")
		return
	}

	client, release, _, _, err := h.acquireClient(r.Context(), r)
	if err != nil {
		response.InternalServerError(w, "failed to get IMAP connection: "+err.Error())
		return
	}
	defer release()

	if err := client.SetFlags(r.Context(), req.Folder, req.UIDs, req.Flags, req.Op); err != nil {
		response.InternalServerError(w, "failed to update flags: "+err.Error())
		return
	}

	response.Success(w, map[string]string{"message": "flags updated successfully"})
}

// MoveRequest 批次移動郵件請求
type MoveRequest struct {
	Folder     string   `json:"folder"`
	UIDs       []uint32 `json:"uids"`
	DestFolder string   `json:"destFolder"`
}

// MoveMessages 批次移動郵件
func (h *MailHandler) MoveMessages(w http.ResponseWriter, r *http.Request) {
	var req MoveRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		response.BadRequest(w, "invalid request body")
		return
	}

	if req.Folder == "" || req.DestFolder == "" || len(req.UIDs) == 0 {
		response.BadRequest(w, "folder, destFolder, and uids are required")
		return
	}

	client, release, _, _, err := h.acquireClient(r.Context(), r)
	if err != nil {
		response.InternalServerError(w, "failed to get IMAP connection: "+err.Error())
		return
	}
	defer release()

	if err := client.MoveMessages(r.Context(), req.Folder, req.UIDs, req.DestFolder); err != nil {
		log.Printf("[MAIL] move messages FAILED: folder=%s uids=%v dest=%s err=%v", req.Folder, req.UIDs, req.DestFolder, err)
		response.InternalServerError(w, "failed to move messages: "+err.Error())
		return
	}

	log.Printf("[MAIL] move messages OK: folder=%s uids=%v dest=%s", req.Folder, req.UIDs, req.DestFolder)
	response.Success(w, map[string]string{"message": "messages moved successfully"})
}

// EmptyFolderRequest 清空資料夾請求
type EmptyFolderRequest struct {
	Folder string `json:"folder"`
}

// EmptyFolder 清空指定資料夾（例如 Trash）
func (h *MailHandler) EmptyFolder(w http.ResponseWriter, r *http.Request) {
	var req EmptyFolderRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		response.BadRequest(w, "invalid request body")
		return
	}
	if req.Folder == "" {
		response.BadRequest(w, "folder is required")
		return
	}

	client, release, _, _, err := h.acquireClient(r.Context(), r)
	if err != nil {
		response.InternalServerError(w, "failed to get IMAP connection: "+err.Error())
		return
	}
	defer release()

	if err := client.EmptyFolder(r.Context(), req.Folder); err != nil {
		log.Printf("[MAIL] empty folder FAILED: folder=%s err=%v", req.Folder, err)
		response.InternalServerError(w, "failed to empty folder: "+err.Error())
		return
	}

	log.Printf("[MAIL] empty folder OK: folder=%s", req.Folder)
	response.Success(w, map[string]string{"message": "folder emptied successfully"})
}

// DeleteRequest 批次刪除郵件請求
type DeleteRequest struct {
	Folder    string   `json:"folder"`
	UIDs      []uint32 `json:"uids"`
	Permanent bool     `json:"permanent"`
}

// DeleteMessages 刪除郵件（預設移至 Trash，支援永久刪除）
func (h *MailHandler) DeleteMessages(w http.ResponseWriter, r *http.Request) {
	var req DeleteRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		response.BadRequest(w, "invalid request body")
		return
	}

	if req.Folder == "" {
		req.Folder = "INBOX"
	}
	if len(req.UIDs) == 0 {
		response.BadRequest(w, "uids cannot be empty")
		return
	}

	client, release, _, _, err := h.acquireClient(r.Context(), r)
	if err != nil {
		response.InternalServerError(w, "failed to get IMAP connection: "+err.Error())
		return
	}
	defer release()

	if err := client.DeleteMessages(r.Context(), req.Folder, req.UIDs, req.Permanent); err != nil {
		log.Printf("[MAIL] delete FAILED: folder=%s uids=%v permanent=%v err=%v", req.Folder, req.UIDs, req.Permanent, err)
		response.InternalServerError(w, "failed to delete messages: "+err.Error())
		return
	}

	log.Printf("[MAIL] delete OK: folder=%s uids=%v permanent=%v", req.Folder, req.UIDs, req.Permanent)
	response.Success(w, map[string]string{"message": "messages deleted successfully"})
}

// SendMessage 透過 SMTP 發送郵件並自動附加存入 IMAP「已發送 (Sent)」資料夾
func (h *MailHandler) SendMessage(w http.ResponseWriter, r *http.Request) {
	authCtx, acc := middleware.GetCurrentAccount(r.Context(), r)
	if authCtx == nil || acc == nil {
		response.BadRequest(w, "no account selected")
		return
	}
	accountPassword := middleware.GetCurrentAccountPassword(authCtx, acc)

	var outMsg smtp.OutgoingMessage

	contentType := r.Header.Get("Content-Type")
	if strings.HasPrefix(contentType, "multipart/form-data") {
		// 支援包含上傳附件的 multipart 請求（限制 32MB）
		if err := r.ParseMultipartForm(32 << 20); err != nil {
			response.BadRequest(w, "failed to parse multipart form: "+err.Error())
			return
		}

		outMsg.From = acc.Email
		if fromForm := r.FormValue("from"); fromForm != "" {
			outMsg.From = fromForm
		}
		if toForm := r.FormValue("to"); toForm != "" {
			outMsg.To = strings.Split(toForm, ",")
		}
		if ccForm := r.FormValue("cc"); ccForm != "" {
			outMsg.Cc = strings.Split(ccForm, ",")
		}
		if bccForm := r.FormValue("bcc"); bccForm != "" {
			outMsg.Bcc = strings.Split(bccForm, ",")
		}
		outMsg.Subject = r.FormValue("subject")
		outMsg.InReplyTo = r.FormValue("inReplyTo")
		outMsg.References = r.FormValue("references")
		outMsg.TextBody = r.FormValue("textBody")
		outMsg.HTMLBody = r.FormValue("htmlBody")

		// 處理上傳附件
		if r.MultipartForm != nil && r.MultipartForm.File != nil {
			for _, fileHeaders := range r.MultipartForm.File {
				for _, fh := range fileHeaders {
					f, err := fh.Open()
					if err == nil {
						data, _ := io.ReadAll(f)
						_ = f.Close()
						outMsg.Attachments = append(outMsg.Attachments, smtp.OutgoingAttachment{
							Filename:    fh.Filename,
							ContentType: fh.Header.Get("Content-Type"),
							Data:        data,
						})
					}
				}
			}
		}
	} else {
		// 標準 JSON 請求
		if err := json.NewDecoder(r.Body).Decode(&outMsg); err != nil {
			response.BadRequest(w, "invalid json payload: "+err.Error())
			return
		}
		if outMsg.From == "" {
			outMsg.From = acc.Email
		}
	}

	if len(outMsg.To) == 0 {
		response.BadRequest(w, "at least one recipient (to) is required")
		return
	}

	smtpCfg := smtp.SMTPConfig{
		Host:             acc.SMTPHost,
		Port:             acc.SMTPPort,
		UseTLS:           acc.SMTPUseTLS,
		AllowInsecureTLS: acc.SMTPAllowInsecureTLS,
		Username:         acc.Username,
		Password:         accountPassword,
	}

	log.Printf("[SMTP] Sending email from %s to %v via %s:%d...", outMsg.From, outMsg.To, smtpCfg.Host, smtpCfg.Port)

	// 先組裝完整的 RFC 5322 MIME 郵件資料
	rawMIME, _ := h.sender.BuildMIMEMessage(outMsg)

	// 透過 SMTP 送出
	if err := h.sender.Send(r.Context(), smtpCfg, outMsg); err != nil {
		log.Printf("[SMTP ERROR] Send failed: %v", err)
		response.InternalServerError(w, "failed to send email via SMTP: "+err.Error())
		return
	}

	log.Printf("[SMTP SUCCESS] Email successfully delivered to %v", outMsg.To)

	// 成功寄出後，自動在背景透過 IMAP APPEND 將該郵件寫入發件人的「已發送 (Sent)」資料夾
	if len(rawMIME) > 0 {
		go func(sessID, accountID string, acct storage.Account, pass string, mimeData []byte) {
			ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
			defer cancel()

			cfg := imapinternal.ConnectionConfig{
				Host:             acct.IMAPHost,
				Port:             acct.IMAPPort,
				UseTLS:           acct.IMAPUseTLS,
				AllowInsecureTLS: acct.IMAPAllowInsecureTLS,
				Username:         acct.Username,
				Password:         pass,
			}
			imapClient, release, err := h.poolMgr.GetClient(ctx, sessID, accountID, cfg)
			if err != nil {
				log.Printf("[SENT APPEND ERROR] failed to acquire IMAP client: %v", err)
				return
			}
			defer release()

			sentFolder := imapClient.FindSentFolder(ctx)
			if appendErr := imapClient.AppendMessage(ctx, sentFolder, mimeData, []imap.Flag{imap.FlagSeen}); appendErr != nil {
				log.Printf("[SENT APPEND ERROR] failed to append copy to %s: %v", sentFolder, appendErr)
			} else {
				log.Printf("[SENT APPEND SUCCESS] Saved copy to sent folder: %s", sentFolder)
			}
		}(authCtx.Session.ID, acc.ID, *acc, accountPassword, rawMIME)
	}

	response.Success(w, map[string]string{"message": "email sent successfully"})
}
