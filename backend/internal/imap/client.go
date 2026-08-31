package imap

import (
	"context"
	"crypto/tls"
	"fmt"
	"io"
	"sort"
	"strings"
	"time"

	"github.com/emersion/go-imap/v2"
	"github.com/emersion/go-imap/v2/imapclient"
	"github.com/johnwmail/e2mail/backend/pkg/charsetutil"
)

// ConnectionConfig 連線設定
type ConnectionConfig struct {
	Host             string
	Port             int
	UseTLS           bool
	AllowInsecureTLS bool
	Username         string
	Password         string
	// OnMailboxUpdate 係可選 callback，喺 IMAP unilateral mailbox 更新
	// （例如新郵件到達，NumMessages 變化）時被呼叫。IDLE 監聽用。
	OnMailboxUpdate func(numMessages *uint32)
}

// FolderInfo 資料夾結構
type FolderInfo struct {
	Name        string   `json:"name"`
	Delimiter   string   `json:"delimiter"`
	Attributes  []string `json:"attributes"`
	TotalCount  uint32   `json:"totalCount"`
	UnreadCount uint32   `json:"unreadCount"`
	SpecialUse  string   `json:"specialUse,omitempty"`
	Subscribed  bool     `json:"subscribed"`
}

// SelectResult 選取資料夾狀態
type SelectResult struct {
	Name        string `json:"name"`
	TotalCount  uint32 `json:"totalCount"`
	UnreadCount uint32 `json:"unreadCount"`
	UIDValidity uint32 `json:"uidValidity"`
	UIDNext     uint32 `json:"uidNext"`
}

// MessageListResult 郵件分頁清單
type MessageListResult struct {
	Folder     string           `json:"folder"`
	Mode       string           `json:"mode,omitempty"` // "messages"（缺省）
	Total      int              `json:"total"`
	Page       int              `json:"page"`
	Limit      int              `json:"limit"`
	TotalPages int              `json:"totalPages"`
	Messages   []MessageSummary `json:"messages"`
}

// Client 封裝 go-imap/v2 用戶端
type Client struct {
	rawClient *imapclient.Client
	config    ConnectionConfig
	lastUsed  time.Time
}

// NewClient 建立並驗證 IMAP 連線
func NewClient(config ConnectionConfig) (*Client, error) {
	addr := fmt.Sprintf("%s:%d", config.Host, config.Port)
	tlsConfig := &tls.Config{
		ServerName:         config.Host,
		InsecureSkipVerify: config.AllowInsecureTLS,
	}
	dialOptions := func() *imapclient.Options {
		opts := &imapclient.Options{TLSConfig: tlsConfig}
		if config.OnMailboxUpdate != nil {
			opts.UnilateralDataHandler = &imapclient.UnilateralDataHandler{
				Mailbox: func(data *imapclient.UnilateralDataMailbox) {
					config.OnMailboxUpdate(data.NumMessages)
				},
			}
		}
		return opts
	}

	var raw *imapclient.Client
	var err error

	if config.UseTLS || config.Port == 993 {
		raw, err = imapclient.DialTLS(addr, dialOptions())
	} else if config.Port == 143 {
		// 嘗試 STARTTLS 協商
		raw, err = imapclient.DialStartTLS(addr, dialOptions())
		if err != nil {
			// 若 STARTTLS 失敗，嘗試非加密直連
			raw, err = imapclient.DialInsecure(addr, dialOptions())
		}
	} else {
		raw, err = imapclient.DialInsecure(addr, dialOptions())
	}

	if err != nil {
		return nil, fmt.Errorf("IMAP connection failed to %s: %w", addr, err)
	}

	// 登入驗證：支援完整 Email 帳號與純使用者名稱 (@ 前綴) 自動適配
	loginErr := raw.Login(config.Username, config.Password).Wait()
	if loginErr != nil && strings.Contains(config.Username, "@") {
		// 重新連線以嘗試純帳號登入 (部分 Dovecot/Linux 系統要求純帳號名)
		_ = raw.Close()
		prefixUser := strings.Split(config.Username, "@")[0]

		if config.UseTLS || config.Port == 993 {
			raw, err = imapclient.DialTLS(addr, dialOptions())
		} else {
			raw, err = imapclient.DialInsecure(addr, dialOptions())
		}

		if err == nil {
			if retryErr := raw.Login(prefixUser, config.Password).Wait(); retryErr == nil {
				config.Username = prefixUser
				loginErr = nil
			}
		}
	}

	if loginErr != nil {
		if raw != nil {
			_ = raw.Close()
		}
		return nil, fmt.Errorf("IMAP login failed for user %s: %w", config.Username, loginErr)
	}

	return &Client{
		rawClient: raw,
		config:    config,
		lastUsed:  time.Now(),
	}, nil
}

// Raw 取得底層 go-imap client
func (c *Client) Raw() *imapclient.Client {
	return c.rawClient
}

// ListFolders 取得信箱資料夾清單及其狀態
func (c *Client) ListFolders(ctx context.Context) ([]FolderInfo, error) {
	c.lastUsed = time.Now()

	mailboxes, err := c.rawClient.List("", "*", nil).Collect()
	if err != nil {
		return nil, fmt.Errorf("failed to list mailboxes: %w", err)
	}

	// 嘗試攞訂閱狀態（LIST-EXTENDED；唔支援嘅 server 就全部視作未訂閱）
	subscribed := map[string]bool{}
	if sub, err := c.ListSubscribed(ctx); err == nil {
		subscribed = sub
	}

	var results []FolderInfo
	for _, mb := range mailboxes {
		var attrs []string
		for _, a := range mb.Attrs {
			attrs = append(attrs, string(a))
		}

		statusOpts := &imap.StatusOptions{
			NumMessages: true,
			NumUnseen:   true,
		}
		statusData, err := c.rawClient.Status(mb.Mailbox, statusOpts).Wait()
		var total, unread uint32
		if err == nil && statusData != nil {
			if statusData.NumMessages != nil {
				total = *statusData.NumMessages
			}
			if statusData.NumUnseen != nil {
				unread = *statusData.NumUnseen
			}
		}

		specialUse := ""
		for _, a := range attrs {
			al := strings.ToLower(a)
			if strings.Contains(al, "inbox") {
				specialUse = "inbox"
			} else if strings.Contains(al, "sent") {
				specialUse = "sent"
			} else if strings.Contains(al, "draft") {
				specialUse = "drafts"
			} else if strings.Contains(al, "trash") || strings.Contains(al, "bin") {
				specialUse = "trash"
			} else if strings.Contains(al, "junk") || strings.Contains(al, "spam") {
				specialUse = "junk"
			} else if strings.Contains(al, "archive") {
				specialUse = "archive"
			}
		}
		if specialUse == "" && strings.EqualFold(mb.Mailbox, "INBOX") {
			specialUse = "inbox"
		}

		results = append(results, FolderInfo{
			Name:        mb.Mailbox,
			Delimiter:   string(mb.Delim),
			Attributes:  attrs,
			TotalCount:  total,
			UnreadCount: unread,
			SpecialUse:  specialUse,
			Subscribed:  subscribed[mb.Mailbox] || strings.EqualFold(mb.Mailbox, "INBOX"),
		})
	}

	return results, nil
}

// EnsureFolder 若資料夾唔存在則建立（重名忽略）。返回最終資料夾名。
func (c *Client) EnsureFolder(ctx context.Context, folder string) (string, error) {
	if folder == "" {
		folder = "Junk"
	}
	// 檢查是否已存在
	exists := false
	if mailboxes, err := c.rawClient.List("", "*", nil).Collect(); err == nil {
		for _, mb := range mailboxes {
			if strings.EqualFold(mb.Mailbox, folder) {
				exists = true
				break
			}
		}
	}
	if !exists {
		if err := c.rawClient.Create(folder, nil).Wait(); err != nil {
			return folder, fmt.Errorf("failed to create folder %s: %w", folder, err)
		}
	}
	return folder, nil
}

// ListSubscribed 回傳已訂閱資料夾集合（LIST (SUBSCRIBED) "" "*"；需 LIST-EXTENDED）
func (c *Client) ListSubscribed(ctx context.Context) (map[string]bool, error) {
	c.lastUsed = time.Now()

	mailboxes, err := c.rawClient.List("", "*", &imap.ListOptions{SelectSubscribed: true}).Collect()
	if err != nil {
		return nil, err
	}
	set := make(map[string]bool, len(mailboxes))
	for _, mb := range mailboxes {
		set[mb.Mailbox] = true
	}
	return set, nil
}

// SubscribeFolder 訂閱 IMAP 資料夾
func (c *Client) SubscribeFolder(ctx context.Context, folder string) error {
	c.lastUsed = time.Now()
	if err := c.rawClient.Subscribe(folder).Wait(); err != nil {
		return fmt.Errorf("failed to subscribe %s: %w", folder, err)
	}
	return nil
}

// UnsubscribeFolder 取消訂閱 IMAP 資料夾
func (c *Client) UnsubscribeFolder(ctx context.Context, folder string) error {
	c.lastUsed = time.Now()
	if err := c.rawClient.Unsubscribe(folder).Wait(); err != nil {
		return fmt.Errorf("failed to unsubscribe %s: %w", folder, err)
	}
	return nil
}

// FindSentFolder 自動尋找伺服器上的「已發送 (Sent)」資料夾
func (c *Client) FindSentFolder(ctx context.Context) string {
	folders, err := c.ListFolders(ctx)
	if err == nil {
		// 1. 檢查 SpecialUse
		for _, f := range folders {
			if strings.EqualFold(f.SpecialUse, "sent") {
				return f.Name
			}
			for _, attr := range f.Attributes {
				if strings.EqualFold(attr, `\Sent`) || strings.EqualFold(attr, "sent") {
					return f.Name
				}
			}
		}

		// 2. 檢查名稱匹配
		for _, f := range folders {
			nameLower := strings.ToLower(f.Name)
			if nameLower == "sent" || nameLower == "sent messages" || nameLower == "sent items" || nameLower == "inbox.sent" || strings.Contains(nameLower, "sent") {
				return f.Name
			}
		}
	}
	return "Sent"
}

// AppendMessage 將郵件附加寫入指定資料夾 (例如 "Sent" 資料夾)
func (c *Client) AppendMessage(ctx context.Context, folder string, rawMIME []byte, flags []imap.Flag) error {
	c.lastUsed = time.Now()

	opts := &imap.AppendOptions{
		Flags: flags,
		Time:  time.Now(),
	}

	cmd := c.rawClient.Append(folder, int64(len(rawMIME)), opts)
	if _, err := cmd.Write(rawMIME); err != nil {
		_ = cmd.Close()
		return fmt.Errorf("failed to write mail data to append command: %w", err)
	}

	if err := cmd.Close(); err != nil {
		return fmt.Errorf("failed to close append command: %w", err)
	}

	if _, err := cmd.Wait(); err != nil {
		return fmt.Errorf("failed to append message to %s: %w", folder, err)
	}

	return nil
}

// SelectFolder 選取資料夾
func (c *Client) SelectFolder(ctx context.Context, folder string) (*SelectResult, error) {
	c.lastUsed = time.Now()
	data, err := c.rawClient.Select(folder, nil).Wait()
	if err != nil {
		return nil, fmt.Errorf("failed to select mailbox %s: %w", folder, err)
	}

	res := &SelectResult{
		Name:        folder,
		TotalCount:  data.NumMessages,
		UIDValidity: data.UIDValidity,
		UIDNext:     uint32(data.UIDNext),
	}

	status, err := c.rawClient.Status(folder, &imap.StatusOptions{NumUnseen: true}).Wait()
	if err == nil && status != nil && status.NumUnseen != nil {
		res.UnreadCount = *status.NumUnseen
	}

	return res, nil
}

// FetchMessageSummaries 取得郵件摘要清單
func (c *Client) FetchMessageSummaries(ctx context.Context, folder string, page, limit int, query string) (*MessageListResult, error) {
	c.lastUsed = time.Now()

	selectData, err := c.rawClient.Select(folder, nil).Wait()
	if err != nil {
		return nil, fmt.Errorf("failed to select folder %s: %w", folder, err)
	}

	total := int(selectData.NumMessages)
	if total == 0 {
		return &MessageListResult{
			Folder:     folder,
			Total:      0,
			Page:       page,
			Limit:      limit,
			TotalPages: 0,
			Messages:   []MessageSummary{},
		}, nil
	}

	var matchedSeqNums []uint32

	if query != "" {
		criteria, usesAttachment := buildSearchCriteria(query)
		if criteria != nil {
			searchData, err := c.rawClient.Search(criteria, nil).Wait()
			if err != nil && usesAttachment {
				// 某些伺服器唔支援 \HasAttachment keyword → 撤回重試
				if c2, _ := buildSearchCriteriaNoAttachment(query); c2 != nil {
					searchData, err = c.rawClient.Search(c2, nil).Wait()
				}
			}
			if err != nil {
				return nil, fmt.Errorf("search failed: %w", err)
			}
			matchedSeqNums = append(matchedSeqNums, searchData.AllSeqNums()...)
			total = len(matchedSeqNums)
		} else {
			// 查詢只有無意義 operator → 當作無過濾
			for i := uint32(1); i <= selectData.NumMessages; i++ {
				matchedSeqNums = append(matchedSeqNums, i)
			}
		}
	} else {
		for i := uint32(1); i <= selectData.NumMessages; i++ {
			matchedSeqNums = append(matchedSeqNums, i)
		}
	}

	// 降序排序（最新郵件在最前）
	sort.Slice(matchedSeqNums, func(i, j int) bool {
		return matchedSeqNums[i] > matchedSeqNums[j]
	})

	totalPages := (total + limit - 1) / limit
	if page < 1 {
		page = 1
	}

	start := (page - 1) * limit
	if start >= total {
		return &MessageListResult{
			Folder:     folder,
			Total:      total,
			Page:       page,
			Limit:      limit,
			TotalPages: totalPages,
			Messages:   []MessageSummary{},
		}, nil
	}

	end := start + limit
	if end > total {
		end = total
	}

	pageSeqNums := matchedSeqNums[start:end]
	if len(pageSeqNums) == 0 {
		return &MessageListResult{
			Folder:     folder,
			Total:      total,
			Page:       page,
			Limit:      limit,
			TotalPages: totalPages,
			Messages:   []MessageSummary{},
		}, nil
	}

	var seqSet imap.SeqSet
	for _, num := range pageSeqNums {
		seqSet.AddNum(num)
	}

	fetchOpts := &imap.FetchOptions{
		UID:          true,
		Flags:        true,
		Envelope:     true,
		InternalDate: true,
		RFC822Size:   true,
	}

	fetchCmd := c.rawClient.Fetch(seqSet, fetchOpts)
	var summaries []MessageSummary

	for {
		msgData := fetchCmd.Next()
		if msgData == nil {
			break
		}

		var summary MessageSummary
		for {
			item := msgData.Next()
			if item == nil {
				break
			}
			switch it := item.(type) {
			case imapclient.FetchItemDataUID:
				summary.UID = uint32(it.UID)
			case imapclient.FetchItemDataFlags:
				for _, f := range it.Flags {
					summary.Flags = append(summary.Flags, string(f))
					if f == imap.FlagSeen {
						summary.Unread = false
					}
					if f == imap.FlagFlagged {
						summary.Starred = true
					}
				}
				// 若沒有 Seen 標籤則為未讀
				isSeen := false
				for _, f := range it.Flags {
					if f == imap.FlagSeen {
						isSeen = true
						break
					}
				}
				summary.Unread = !isSeen
			case imapclient.FetchItemDataEnvelope:
				summary.Subject = charsetutil.DecodeRFC2047(it.Envelope.Subject)
				summary.MessageID = it.Envelope.MessageID
				for _, from := range it.Envelope.From {
					summary.From = append(summary.From, EmailAddress{
						Name:    charsetutil.DecodeRFC2047(from.Name),
						Address: from.Addr(),
					})
				}
				for _, to := range it.Envelope.To {
					summary.To = append(summary.To, EmailAddress{
						Name:    charsetutil.DecodeRFC2047(to.Name),
						Address: to.Addr(),
					})
				}
				summary.Date = it.Envelope.Date
			case imapclient.FetchItemDataInternalDate:
				if summary.Date.IsZero() {
					summary.Date = it.Time
				}
			case imapclient.FetchItemDataRFC822Size:
				summary.Size = uint32(it.Size)
			}
		}

		summaries = append(summaries, summary)
	}

	if err := fetchCmd.Close(); err != nil {
		return nil, fmt.Errorf("failed to fetch message summaries: %w", err)
	}

	// 確保最新郵件在最前（按 UID 降序，UID 隨新郵件遞增）
	sort.Slice(summaries, func(i, j int) bool {
		if summaries[i].UID != summaries[j].UID {
			return summaries[i].UID > summaries[j].UID
		}
		return summaries[i].Date.After(summaries[j].Date)
	})

	return &MessageListResult{
		Folder:     folder,
		Total:      total,
		Page:       page,
		Limit:      limit,
		TotalPages: totalPages,
		Messages:   summaries,
	}, nil
}

// FetchMessageDetail 取得特定 UID 郵件的完整內文與附件結構
func (c *Client) FetchMessageDetail(ctx context.Context, folder string, uid uint32) (*ParsedMessage, error) {
	c.lastUsed = time.Now()

	if _, err := c.rawClient.Select(folder, nil).Wait(); err != nil {
		return nil, fmt.Errorf("failed to select folder %s: %w", folder, err)
	}

	var uidSet imap.UIDSet
	uidSet.AddNum(imap.UID(uid))

	var bodySection imap.FetchItemBodySection
	fetchOpts := &imap.FetchOptions{
		UID:          true,
		Flags:        true,
		Envelope:     true,
		InternalDate: true,
		RFC822Size:   true,
		BodySection:  []*imap.FetchItemBodySection{&bodySection},
	}

	fetchCmd := c.rawClient.Fetch(uidSet, fetchOpts)

	var rawRFC822 []byte
	var parsed ParsedMessage
	parsed.UID = uid

	msgData := fetchCmd.Next()
	if msgData == nil {
		_ = fetchCmd.Close()
		return nil, fmt.Errorf("message with UID %d not found", uid)
	}

	for {
		item := msgData.Next()
		if item == nil {
			break
		}
		switch it := item.(type) {
		case imapclient.FetchItemDataFlags:
			for _, f := range it.Flags {
				parsed.Flags = append(parsed.Flags, string(f))
				if f == imap.FlagSeen {
					parsed.Unread = false
				}
				if f == imap.FlagFlagged {
					parsed.Starred = true
				}
				if f == imap.FlagAnswered {
					parsed.Answered = true
				}
			}
			isSeen := false
			for _, f := range it.Flags {
				if f == imap.FlagSeen {
					isSeen = true
					break
				}
			}
			parsed.Unread = !isSeen
		case imapclient.FetchItemDataEnvelope:
			parsed.Subject = charsetutil.DecodeRFC2047(it.Envelope.Subject)
			parsed.MessageID = it.Envelope.MessageID
			for _, from := range it.Envelope.From {
				parsed.From = append(parsed.From, EmailAddress{
					Name:    charsetutil.DecodeRFC2047(from.Name),
					Address: from.Addr(),
				})
			}
			for _, to := range it.Envelope.To {
				parsed.To = append(parsed.To, EmailAddress{
					Name:    charsetutil.DecodeRFC2047(to.Name),
					Address: to.Addr(),
				})
			}
			for _, cc := range it.Envelope.Cc {
				parsed.Cc = append(parsed.Cc, EmailAddress{
					Name:    charsetutil.DecodeRFC2047(cc.Name),
					Address: cc.Addr(),
				})
			}
			for _, bcc := range it.Envelope.Bcc {
				parsed.Bcc = append(parsed.Bcc, EmailAddress{
					Name:    charsetutil.DecodeRFC2047(bcc.Name),
					Address: bcc.Addr(),
				})
			}
			for _, replyTo := range it.Envelope.ReplyTo {
				parsed.ReplyTo = append(parsed.ReplyTo, EmailAddress{
					Name:    charsetutil.DecodeRFC2047(replyTo.Name),
					Address: replyTo.Addr(),
				})
			}
			parsed.Date = it.Envelope.Date
		case imapclient.FetchItemDataInternalDate:
			if parsed.Date.IsZero() {
				parsed.Date = it.Time
			}
		case imapclient.FetchItemDataRFC822Size:
			parsed.Size = uint32(it.Size)
		case imapclient.FetchItemDataBodySection:
			buf, err := io.ReadAll(it.Literal)
			if err == nil {
				rawRFC822 = buf
			}
		}
	}

	if err := fetchCmd.Close(); err != nil {
		return nil, fmt.Errorf("failed to complete fetch command: %w", err)
	}

	if len(rawRFC822) > 0 {
		textBody, htmlBody, attachments, parseErr := ParseRFC822(rawRFC822)
		if parseErr == nil {
			parsed.TextBody = textBody
			parsed.HTMLBody = htmlBody
			parsed.Attachments = attachments
		} else {
			parsed.TextBody = string(rawRFC822)
		}
	}

	return &parsed, nil
}

// FetchRawMessage 取得指定 UID 郵件嘅原始 RFC822 來源
func (c *Client) FetchRawMessage(ctx context.Context, folder string, uid uint32) ([]byte, error) {
	c.lastUsed = time.Now()

	if _, err := c.rawClient.Select(folder, nil).Wait(); err != nil {
		return nil, fmt.Errorf("failed to select folder %s: %w", folder, err)
	}

	var uidSet imap.UIDSet
	uidSet.AddNum(imap.UID(uid))

	var bodySection imap.FetchItemBodySection
	fetchOpts := &imap.FetchOptions{
		BodySection: []*imap.FetchItemBodySection{&bodySection},
	}

	fetchCmd := c.rawClient.Fetch(uidSet, fetchOpts)
	msgData := fetchCmd.Next()
	if msgData == nil {
		_ = fetchCmd.Close()
		return nil, fmt.Errorf("message with UID %d not found", uid)
	}

	var raw []byte
	for {
		item := msgData.Next()
		if item == nil {
			break
		}
		if it, ok := item.(imapclient.FetchItemDataBodySection); ok {
			buf, err := io.ReadAll(it.Literal)
			if err == nil {
				raw = buf
			}
		}
	}
	_ = fetchCmd.Close()
	if len(raw) == 0 {
		return nil, fmt.Errorf("empty message body for UID %d", uid)
	}
	return raw, nil
}

// SetFlags 批次修改 Flag
func (c *Client) SetFlags(ctx context.Context, folder string, uids []uint32, flags []string, op string) error {
	c.lastUsed = time.Now()

	if _, err := c.rawClient.Select(folder, nil).Wait(); err != nil {
		return fmt.Errorf("failed to select folder %s: %w", folder, err)
	}

	var uidSet imap.UIDSet
	for _, u := range uids {
		uidSet.AddNum(imap.UID(u))
	}

	var imapFlags []imap.Flag
	for _, f := range flags {
		imapFlags = append(imapFlags, imap.Flag(f))
	}

	var storeOp imap.StoreFlagsOp
	switch op {
	case "add":
		storeOp = imap.StoreFlagsAdd
	case "remove":
		storeOp = imap.StoreFlagsDel
	case "set":
		storeOp = imap.StoreFlagsSet
	default:
		storeOp = imap.StoreFlagsSet
	}

	storeOpts := &imap.StoreFlags{
		Op:     storeOp,
		Flags:  imapFlags,
		Silent: true,
	}

	storeCmd := c.rawClient.Store(uidSet, storeOpts, nil)
	return storeCmd.Close()
}

// MoveMessages 批次移動郵件
func (c *Client) MoveMessages(ctx context.Context, folder string, uids []uint32, destFolder string) error {
	c.lastUsed = time.Now()

	if _, err := c.rawClient.Select(folder, nil).Wait(); err != nil {
		return fmt.Errorf("failed to select folder %s: %w", folder, err)
	}

	var uidSet imap.UIDSet
	for _, u := range uids {
		uidSet.AddNum(imap.UID(u))
	}

	moveCmd := c.rawClient.Move(uidSet, destFolder)
	_, err := moveCmd.Wait()
	if err != nil {
		// 若伺服器不支援 MOVE，回退至 COPY + DELETE
		copyCmd := c.rawClient.Copy(uidSet, destFolder)
		if _, copyErr := copyCmd.Wait(); copyErr != nil {
			return fmt.Errorf("fallback copy failed: %w", copyErr)
		}
		_ = c.SetFlags(ctx, folder, uids, []string{string(imap.FlagDeleted)}, "add")
		_ = c.rawClient.Expunge().Close()
	}

	return nil
}

// FindTrashFolder 偵測垃圾桶/Trash 資料夾（special_use=\Trash 或名稱匹配），fallback "Trash"
func (c *Client) FindTrashFolder(ctx context.Context) string {
	folders, err := c.ListFolders(ctx)
	if err == nil {
		for _, f := range folders {
			if strings.EqualFold(f.SpecialUse, "trash") {
				return f.Name
			}
			for _, attr := range f.Attributes {
				if strings.EqualFold(attr, `\Trash`) || strings.EqualFold(attr, "trash") {
					return f.Name
				}
			}
		}
		for _, f := range folders {
			nameLower := strings.ToLower(f.Name)
			if nameLower == "trash" || nameLower == "deleted messages" || nameLower == "deleted" || strings.Contains(nameLower, "trash") {
				return f.Name
			}
		}
	}
	return "Trash"
}

// DeleteMessages 批次刪除郵件
func (c *Client) DeleteMessages(ctx context.Context, folder string, uids []uint32, permanent bool) error {
	c.lastUsed = time.Now()

	if !permanent && !strings.EqualFold(folder, "Trash") {
		// server 若未有 trash folder 則自動建立（Dovecot 未必預設 \Trash）
		trash := c.FindTrashFolder(ctx)
		trash, _ = c.EnsureFolder(ctx, trash)
		return c.MoveMessages(ctx, folder, uids, trash)
	}

	if _, err := c.rawClient.Select(folder, nil).Wait(); err != nil {
		return fmt.Errorf("failed to select folder %s: %w", folder, err)
	}

	if err := c.SetFlags(ctx, folder, uids, []string{string(imap.FlagDeleted)}, "add"); err != nil {
		return err
	}

	return c.rawClient.Expunge().Close()
}

// EmptyFolder 清空資料夾（select → 全部標記 \Deleted → expunge；Trash 清空用）
func (c *Client) EmptyFolder(ctx context.Context, folder string) error {
	if c == nil || c.rawClient == nil {
		return fmt.Errorf("imap client not connected")
	}
	c.lastUsed = time.Now()

	selectData, err := c.rawClient.Select(folder, nil).Wait()
	if err != nil {
		return fmt.Errorf("failed to select folder %s: %w", folder, err)
	}
	if selectData.NumMessages == 0 {
		return nil // 已空
	}

	// 用 sequence set 1:*（全部訊息）標記 \Deleted
	storeOpts := &imap.StoreFlags{
		Op:     imap.StoreFlagsAdd,
		Flags:  []imap.Flag{imap.FlagDeleted},
		Silent: true,
	}
	var seqSet imap.SeqSet
	seqSet.AddRange(1, 0) // 1:* = 全部
	storeCmd := c.rawClient.Store(seqSet, storeOpts, nil)
	if err := storeCmd.Close(); err != nil {
		return fmt.Errorf("failed to mark %s messages as deleted: %w", folder, err)
	}

	return c.rawClient.Expunge().Close()
}

// Close 關閉連線
func (c *Client) Close() error {
	if c.rawClient != nil {
		return c.rawClient.Close()
	}
	return nil
}
