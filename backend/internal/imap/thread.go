package imap

import (
	"context"
	"fmt"
	"io"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/emersion/go-imap/v2"
	"github.com/emersion/go-imap/v2/imapclient"
	"github.com/johnwmail/e2mail/backend/pkg/charsetutil"
)

// ===== Thread 資料結構 =====

// ThreadIDMessage 為 MessageSummary 嘅 thread 擴充欄（flat 模式 omitempty 不受影響）

// ThreadSummary 一個對話串嘅摘要（含成員清單）
type ThreadSummary struct {
	ThreadID      string           `json:"threadId"`
	Subject       string           `json:"subject"`
	Date          time.Time        `json:"date"` // 組內最新
	Senders       []string         `json:"senders"`
	MessageCount  int              `json:"messageCount"`
	UnreadCount   int              `json:"unreadCount"`
	Starred       bool             `json:"starred"`
	HasAttachment bool             `json:"hasAttachment"`
	Messages      []MessageSummary `json:"messages"` // date 降序（Gmail 式：最新喺頂），最多 20
}

// ThreadListResult thread 模式清單回傳
type ThreadListResult struct {
	Folder     string          `json:"folder"`
	Mode       string          `json:"mode"`
	Total      int             `json:"total"` // thread 總數
	Page       int             `json:"page"`
	Limit      int             `json:"limit"`
	TotalPages int             `json:"totalPages"`
	Threads    []ThreadSummary `json:"threads"`
}

// threadNode 索引內單封訊息
type threadNode struct {
	uid     uint32
	msgID   string // 正規化（小寫、無尖括號）
	refs    []string
	subject string
	date    time.Time
	summary MessageSummary
}

// threadIndex per (owner, account, folder) 快取
type threadIndex struct {
	uidValidity uint32
	uidNext     uint32 // 已索引至（不含）
	count       int
	builtAt     time.Time
	nodes       []*threadNode
	byUID       map[uint32]*threadNode
}

// threadIndexStore 全局索引倉
var threadIndexStore sync.Map // key string -> *threadEntry（含 mutex）

type threadEntry struct {
	mu    sync.Mutex
	index *threadIndex
}

const (
	threadIndexTTL     = 60 * time.Second
	threadIndexMaxMsgs = 20000
	threadMaxMembers   = 20
)

// ===== JWZ 分組（純函數，可單元測試） =====

// ThreadInput JWZ 分組輸入
type ThreadInput struct {
	UID        uint32
	MessageID  string
	References []string
	InReplyTo  string
	Subject    string
}

// uf union-find
type uf struct{ parent map[uint32]uint32 }

func newUF(ids []uint32) *uf {
	u := &uf{parent: make(map[uint32]uint32, len(ids))}
	for _, id := range ids {
		u.parent[id] = id
	}
	return u
}

func (u *uf) find(x uint32) uint32 {
	for u.parent[x] != x {
		u.parent[x] = u.parent[u.parent[x]]
		x = u.parent[x]
	}
	return x
}

func (u *uf) union(a, b uint32) {
	ra, rb := u.find(a), u.find(b)
	if ra != rb {
		// 較小 UID 做 root，穩定排序
		if ra > rb {
			ra, rb = rb, ra
		}
		u.parent[rb] = ra
	}
}

var reSubjectPrefix = regexp.MustCompile(`(?i)^\s*(re|fw|fwd|答复|回复|轉寄|转发|antw|aw|was)\s*(\[[^\]]*\]|\([\d]+\))?\s*[:：]\s*`)
var reBracketTag = regexp.MustCompile(`^\s*\[[^\]]*\]\s*`)

// subjectKey 正規化主題：迴圈去 Re:/Fwd: 等前綴（含 [tag]）、小寫、trim
func subjectKey(s string) string {
	s = strings.TrimSpace(strings.ToLower(s))
	if s == "" || s == "(no subject)" || s == "no subject" {
		return ""
	}
	for i := 0; i < 10; i++ {
		before := s
		if loc := reBracketTag.FindStringIndex(s); loc != nil && loc[0] == 0 {
			s = strings.TrimSpace(s[loc[1]:])
		}
		loc := reSubjectPrefix.FindStringIndex(s)
		if loc != nil && loc[0] == 0 {
			s = strings.TrimSpace(s[loc[1]:])
		}
		if s == before {
			break
		}
	}
	return s
}

// normalizeMsgID 去尖括號、小寫、trim
func normalizeMsgID(s string) string {
	s = strings.TrimSpace(s)
	s = strings.TrimPrefix(s, "<")
	s = strings.TrimSuffix(s, ">")
	return strings.ToLower(strings.TrimSpace(s))
}

// GroupThreads JWZ 式分組：refs/inReplyTo 鏈 + subject fallback。
// 回傳每封 UID 所屬 thread root UID。
func GroupThreads(inputs []ThreadInput) map[uint32]uint32 {
	ids := make([]uint32, 0, len(inputs))
	byMsgID := make(map[string]uint32, len(inputs))
	byUID := make(map[uint32]*ThreadInput, len(inputs))
	for i := range inputs {
		in := inputs[i]
		ids = append(ids, in.UID)
		byUID[in.UID] = &inputs[i]
		if in.MessageID != "" {
			if _, exists := byMsgID[in.MessageID]; !exists {
				byMsgID[in.MessageID] = in.UID
			}
		}
	}

	u := newUF(ids)

	// pass 1: 引用鏈（JWZ：由 references 末端搵「組內已有、無循環」嘅 parent）
	subjectAnchored := make(map[uint32]bool, len(inputs))
	for _, in := range inputs {
		candidates := make([]string, 0, len(in.References)+1)
		// 由尾搵返頭
		for i := len(in.References) - 1; i >= 0; i-- {
			candidates = append(candidates, in.References[i])
		}
		if in.InReplyTo != "" {
			candidates = append(candidates, in.InReplyTo)
		}
		linked := false
		for _, cand := range candidates {
			candID := normalizeMsgID(cand)
			if candID == "" || candID == in.MessageID {
				continue
			}
			pUID, ok := byMsgID[candID]
			if !ok || pUID == in.UID {
				continue
			}
			if u.find(pUID) == u.find(in.UID) {
				// 會形成循環 → 斷鏈
				continue
			}
			u.union(pUID, in.UID)
			linked = true
			break
		}
		subjectAnchored[in.UID] = linked
	}

	// pass 2: subject fallback — 僅對「無 msgid 鏈」嘅訊息按 subjKey 掛到最早嘅同主題錨點
	anchorByKey := make(map[string]uint32)
	for _, in := range inputs {
		if in.MessageID != "" && subjectAnchored[in.UID] {
			continue
		}
		key := subjectKey(in.Subject)
		if key == "" {
			continue
		}
		if anchor, ok := anchorByKey[key]; ok {
			if u.find(anchor) != u.find(in.UID) {
				u.union(anchor, in.UID)
				subjectAnchored[in.UID] = true
			}
		} else {
			anchorByKey[key] = in.UID
		}
	}

	out := make(map[uint32]uint32, len(inputs))
	for _, id := range ids {
		out[id] = u.find(id)
	}
	return out
}

// ===== IMAP 客戶端整合 =====

// ThreadUnavailableError folder 過大，thread 降級 flat
type ThreadUnavailableError struct{ Count int }

func (e *ThreadUnavailableError) Error() string {
	return fmt.Sprintf("folder too large for threads (%d messages)", e.Count)
}

func threadCacheKey(owner, host, username, folder string) string {
	return strings.ToLower(owner) + "|" + strings.ToLower(host) + "|" + strings.ToLower(username) + "|" + folder
}

// fetchThreadNodes 由 IMAP 拉取/增量更新索引（假定 folder 已 SELECT）
func (c *Client) fetchThreadNodes(ctx context.Context, folder string, idx *threadIndex, fromUID uint32) error {
	var set imap.NumSet
	if idx == nil || idx.byUID == nil {
		// 全量：1:* seq
		set = imap.SeqSet{imap.SeqRange{Start: 1, Stop: 0}} // Stop 0 = "*"
	} else {
		// 增量：(fromUID):* by UID
		var us imap.UIDSet
		us.AddRange(imap.UID(fromUID), 0)
		set = us
	}

	fetchOpts := &imap.FetchOptions{
		UID:      true,
		Flags:    true,
		Envelope: true,
		BodySection: []*imap.FetchItemBodySection{
			{
				Specifier:    imap.PartSpecifierHeader,
				HeaderFields: []string{"References"},
				Peek:         true,
			},
		},
	}

	fetchCmd := c.rawClient.Fetch(set, fetchOpts)
	for {
		msgData := fetchCmd.Next()
		if msgData == nil {
			break
		}
		var uid uint32
		var env *imap.Envelope
		var refs []string
		unread, starred := true, false
		for {
			item := msgData.Next()
			if item == nil {
				break
			}
			switch it := item.(type) {
			case imapclient.FetchItemDataUID:
				uid = uint32(it.UID)
			case imapclient.FetchItemDataFlags:
				unread, starred = false, false
				for _, f := range it.Flags {
					if f == imap.FlagSeen {
						unread = false
					}
					if f == imap.FlagFlagged {
						starred = true
					}
				}
			case imapclient.FetchItemDataEnvelope:
				env = it.Envelope
			case imapclient.FetchItemDataBodySection:
				if it.Literal != nil {
					raw, err := io.ReadAll(it.Literal)
					if err == nil {
						refs = parseReferencesHeader(string(raw))
					}
				}
			}
		}
		if uid == 0 {
			continue
		}
		node := &threadNode{uid: uid, refs: refs}
		if env != nil {
			node.msgID = normalizeMsgID(env.MessageID)
			node.subject = decodeRFC2047Local(env.Subject)
			node.date = env.Date
			for _, from := range env.From {
				node.summary.From = append(node.summary.From, EmailAddress{
					Name:    decodeRFC2047Local(from.Name),
					Address: from.Addr(),
				})
			}
		}
		node.summary.UID = uid
		node.summary.MessageID = env2msgID(env)
		node.summary.Subject = node.subject
		node.summary.Date = node.date
		node.summary.Unread = unread
		node.summary.Starred = starred
		c.mergeThreadNode(idx, node)
	}
	return fetchCmd.Close()
}

func env2msgID(env *imap.Envelope) string {
	if env == nil {
		return ""
	}
	return env.MessageID
}

// decodeRFC2047Local RFC2047 解碼（同 client.go 行為一致）
func decodeRFC2047Local(s string) string {
	return charsetutil.DecodeRFC2047(s)
}

func (c *Client) mergeThreadNode(idx *threadIndex, node *threadNode) {
	if idx.byUID == nil {
		idx.byUID = make(map[uint32]*threadNode)
	}
	if old, ok := idx.byUID[node.uid]; ok {
		*old = *node
		return
	}
	idx.byUID[node.uid] = node
	idx.nodes = append(idx.nodes, node)
}

// parseReferencesHeader 由 header bytes 攞 References 值（支援折行）
func parseReferencesHeader(raw string) []string {
	// 展開折行
	normalized := strings.ReplaceAll(raw, "\r\n ", " ")
	normalized = strings.ReplaceAll(normalized, "\r\n\t", " ")
	lower := strings.ToLower(normalized)
	idx := strings.Index(lower, "references:")
	if idx < 0 {
		return nil
	}
	value := normalized[idx+len("references:"):]
	if nl := strings.IndexAny(value, "\r\n"); nl >= 0 {
		value = value[:nl]
	}
	var out []string
	for _, part := range strings.Split(value, ">") {
		tok := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(part), "<"))
		if tok != "" {
			out = append(out, normalizeMsgID(tok))
		}
	}
	return out
}

// buildThreadGroups 由索引節點跑 JWZ + 組裝群組（root UID -> members，date 降序 Gmail 式）
func buildThreadGroups(idx *threadIndex) map[uint32][]*threadNode {
	inputs := make([]ThreadInput, 0, len(idx.nodes))
	for _, n := range idx.nodes {
		in := ThreadInput{UID: n.uid, MessageID: n.msgID, References: n.refs, Subject: n.subject}
		inputs = append(inputs, in)
	}
	rootOf := GroupThreads(inputs)
	groups := make(map[uint32][]*threadNode, len(idx.nodes))
	for _, n := range idx.nodes {
		root := rootOf[n.uid]
		groups[root] = append(groups[root], n)
	}
	for uid := range groups {
		members := groups[uid]
		// Gmail 式：最新喺頂（UID 降序 ≈ 時間降序）
		sort.Slice(members, func(i, j int) bool { return members[i].uid > members[j].uid })
	}
	return groups
}

// FetchThreadList thread 模式清單
func (c *Client) FetchThreadList(ctx context.Context, owner, folder string, page, limit int, query string) (*ThreadListResult, error) {
	c.lastUsed = time.Now()

	selectData, err := c.rawClient.Select(folder, nil).Wait()
	if err != nil {
		return nil, fmt.Errorf("failed to select folder %s: %w", folder, err)
	}
	total := int(selectData.NumMessages)
	if total == 0 {
		return &ThreadListResult{Folder: folder, Mode: "threads", Total: 0, Page: page, Limit: limit, Threads: []ThreadSummary{}}, nil
	}
	if total > threadIndexMaxMsgs {
		return nil, &ThreadUnavailableError{Count: total}
	}

	key := threadCacheKey(owner, c.config.Host, c.config.Username, folder)
	entryIface, _ := threadIndexStore.LoadOrStore(key, &threadEntry{})
	entry := entryIface.(*threadEntry)
	entry.mu.Lock()
	idx, err := c.refreshThreadIndexLocked(ctx, entry, selectData, folder, total)
	entry.mu.Unlock()
	if err != nil {
		return nil, err
	}

	groups := buildThreadGroups(filterIndexByQuery(idx, query))
	threads := assembleThreads(groups)
	sort.Slice(threads, func(i, j int) bool { return threads[i].Date.After(threads[j].Date) })

	totalThreads := len(threads)
	totalPages := (totalThreads + limit - 1) / limit
	if page < 1 {
		page = 1
	}
	start := (page - 1) * limit
	if start > totalThreads {
		start = totalThreads
	}
	end := start + limit
	if end > totalThreads {
		end = totalThreads
	}

	return &ThreadListResult{
		Folder:     folder,
		Mode:       "threads",
		Total:      totalThreads,
		Page:       page,
		Limit:      limit,
		TotalPages: totalPages,
		Threads:    threads[start:end],
	}, nil
}

// refreshThreadIndexLocked 依 SELECT 結果決定 build/rebuild/incremental（呼叫者持有 entry.mu）
func (c *Client) refreshThreadIndexLocked(ctx context.Context, entry *threadEntry, selectData *imap.SelectData, folder string, total int) (*threadIndex, error) {
	idx := entry.index
	var reason string
	switch {
	case idx == nil:
		reason = "build"
	case idx.uidValidity != selectData.UIDValidity:
		reason = "rebuild"
	case idx.count != total:
		reason = "rebuild" // expunge/move
	case uint32(selectData.UIDNext) > idx.uidNext:
		reason = "incremental"
	case time.Since(idx.builtAt) > threadIndexTTL:
		reason = "rebuild"
	default:
		reason = "reuse"
	}

	switch reason {
	case "build", "rebuild":
		newIdx := &threadIndex{uidValidity: selectData.UIDValidity, uidNext: uint32(selectData.UIDNext), count: total, builtAt: time.Now()}
		if err := c.fetchThreadNodes(ctx, folder, newIdx, 0); err != nil {
			return nil, err
		}
		entry.index = newIdx
		return newIdx, nil
	case "incremental":
		if err := c.fetchThreadNodes(ctx, folder, idx, idx.uidNext); err != nil {
			// 增量失敗 → 降級全量重建
			rebuild := &threadIndex{uidValidity: selectData.UIDValidity, uidNext: uint32(selectData.UIDNext), count: total, builtAt: time.Now()}
			if err2 := c.fetchThreadNodes(ctx, folder, rebuild, 0); err2 != nil {
				return nil, err2
			}
			entry.index = rebuild
			return rebuild, nil
		}
		idx.uidNext = uint32(selectData.UIDNext)
		idx.count = total
		idx.builtAt = time.Now()
		return idx, nil
	default: // reuse
		return idx, nil
	}
}

// filterIndexByQuery 搜尋模式：只留 match 節點（subject / from 名稱或地址包含 q）
func filterIndexByQuery(idx *threadIndex, query string) *threadIndex {
	q := strings.ToLower(strings.TrimSpace(query))
	if q == "" {
		return idx
	}
	filtered := &threadIndex{byUID: make(map[uint32]*threadNode), uidValidity: idx.uidValidity}
	for _, n := range idx.nodes {
		senderHit := false
		for _, fe := range n.summary.From {
			if strings.Contains(strings.ToLower(fe.Address), q) || strings.Contains(strings.ToLower(fe.Name), q) {
				senderHit = true
				break
			}
		}
		if strings.Contains(strings.ToLower(n.subject), q) || senderHit {
			filtered.nodes = append(filtered.nodes, n)
			filtered.byUID[n.uid] = n
		}
	}
	return filtered
}

// assembleThreads 將分組結果組裝為 ThreadSummary 清單（date 降序成員、cap threadMaxMembers）
func assembleThreads(groups map[uint32][]*threadNode) []ThreadSummary {
	threads := make([]ThreadSummary, 0, len(groups))
	for _, members := range groups {
		var newest *threadNode
		unread, starred, hasAtt := 0, false, false
		senders := make([]string, 0, 4)
		seenSender := make(map[string]bool)
		for _, m := range members {
			if newest == nil || m.date.After(newest.date) {
				newest = m
			}
			if m.summary.Unread {
				unread++
			}
			if m.summary.Starred {
				starred = true
			}
			if m.summary.HasAttachment {
				hasAtt = true
			}
			for _, fe := range m.summary.From {
				addr := fe.Address
				if addr == "" {
					continue
				}
				low := strings.ToLower(addr)
				if !seenSender[low] {
					seenSender[low] = true
					senders = append(senders, addr)
				}
			}
		}
		threadID := "<" + newest.msgID + ">"
		if newest.msgID == "" {
			threadID = fmt.Sprintf("uid:%d", newest.uid)
		}
		msgs := make([]MessageSummary, 0, len(members))
		for i, m := range members {
			if i >= threadMaxMembers {
				break
			}
			ms := m.summary
			ms.ThreadID = threadID
			msgs = append(msgs, ms)
		}
		threads = append(threads, ThreadSummary{
			ThreadID:      threadID,
			Subject:       newest.subject,
			Date:          newest.date,
			Senders:       senders,
			MessageCount:  len(members),
			UnreadCount:   unread,
			Starred:       starred,
			HasAttachment: hasAtt,
			Messages:      msgs,
		})
	}
	return threads
}

// InvalidateThreadIndex SSE 事件（EXPUNGE/NEW_MESSAGE）後標 dirty；簡單起見直接刪
func InvalidateThreadIndex(owner, host, username, folder string) {
	threadIndexStore.Delete(threadCacheKey(owner, host, username, folder))
}
