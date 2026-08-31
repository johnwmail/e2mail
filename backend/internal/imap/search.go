package imap

import (
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/emersion/go-imap/v2"
)

// searchToken 解析後嘅一段查詢（可能有 operator 前綴，或純文字）
type searchToken struct {
	key   string // 小寫 operator（如 "from"、"is"）；空字串 = 純文字
	value string
}

// SearchQuery 已解析嘅 Gmail 風格搜尋條件
type SearchQuery struct {
	Text      []string
	From      []string
	To        []string
	Cc        []string
	Bcc       []string
	Subject   []string
	Body      []string
	Unread    bool
	Read      bool
	Starred   bool
	HasAttach bool
	After     time.Time
	Before    time.Time
	Larger    int64
	Smaller   int64
}

// IsEmpty 冇任何有效條件
func (q *SearchQuery) IsEmpty() bool {
	return len(q.Text) == 0 && len(q.From) == 0 && len(q.To) == 0 && len(q.Cc) == 0 &&
		len(q.Bcc) == 0 && len(q.Subject) == 0 && len(q.Body) == 0 &&
		!q.Unread && !q.Read && !q.Starred && !q.HasAttach &&
		q.After.IsZero() && q.Before.IsZero() && q.Larger == 0 && q.Smaller == 0
}

// BuildCriteria 將已解析條件轉為 IMAP SearchCriteria。第二個 bool 表示用到 \HasAttachment
// （即 has:attachment），方便 caller 喺伺服器唔支援時撤回重試。
func (q *SearchQuery) BuildCriteria() (*imap.SearchCriteria, bool) {
	return q.buildCriteria(false), q.HasAttach
}

// BuildCriteriaNoAttachment 同 BuildCriteria，但撇除 has:attachment（唔會失敗）
func (q *SearchQuery) BuildCriteriaNoAttachment() (*imap.SearchCriteria, bool) {
	return q.buildCriteria(true), false
}

func (q *SearchQuery) buildCriteria(skipAttachment bool) *imap.SearchCriteria {
	var c *imap.SearchCriteria
	add := func(sc *imap.SearchCriteria) {
		if sc == nil {
			return
		}
		if c == nil {
			c = sc
		} else {
			c.And(sc)
		}
	}
	for _, kw := range q.Text {
		add(&imap.SearchCriteria{Text: []string{kw}})
	}
	for _, v := range q.From {
		add(&imap.SearchCriteria{Header: []imap.SearchCriteriaHeaderField{{Key: "From", Value: v}}})
	}
	for _, v := range q.To {
		add(&imap.SearchCriteria{Header: []imap.SearchCriteriaHeaderField{{Key: "To", Value: v}}})
	}
	for _, v := range q.Cc {
		add(&imap.SearchCriteria{Header: []imap.SearchCriteriaHeaderField{{Key: "Cc", Value: v}}})
	}
	for _, v := range q.Bcc {
		add(&imap.SearchCriteria{Header: []imap.SearchCriteriaHeaderField{{Key: "Bcc", Value: v}}})
	}
	for _, v := range q.Subject {
		add(&imap.SearchCriteria{Header: []imap.SearchCriteriaHeaderField{{Key: "Subject", Value: v}}})
	}
	for _, v := range q.Body {
		add(&imap.SearchCriteria{Body: []string{v}})
	}
	if q.Unread {
		add(&imap.SearchCriteria{NotFlag: []imap.Flag{imap.FlagSeen}})
	}
	if q.Read {
		add(&imap.SearchCriteria{Flag: []imap.Flag{imap.FlagSeen}})
	}
	if q.Starred {
		add(&imap.SearchCriteria{Flag: []imap.Flag{imap.FlagFlagged}})
	}
	if q.HasAttach && !skipAttachment {
		add(&imap.SearchCriteria{Flag: []imap.Flag{"\\HasAttachment"}})
	}
	if !q.After.IsZero() {
		add(&imap.SearchCriteria{Since: q.After})
	}
	if !q.Before.IsZero() {
		add(&imap.SearchCriteria{Before: q.Before})
	}
	if q.Larger > 0 {
		add(&imap.SearchCriteria{Larger: q.Larger})
	}
	if q.Smaller > 0 {
		add(&imap.SearchCriteria{Smaller: q.Smaller})
	}
	return c
}

func isSearchKeyChar(c byte) bool {
	return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-'
}

func tokenizeSearch(q string) []searchToken {
	var tokens []searchToken
	i, n := 0, len(q)

	skipSpace := func() {
		for i < n && unicode.IsSpace(rune(q[i])) {
			i++
		}
	}
	readWord := func(from int) (string, int) {
		if from >= n {
			return "", from
		}
		if c := q[from]; c == '"' || c == '\'' {
			j := from + 1
			for j < n && q[j] != c {
				j++
			}
			if j < n {
				return q[from+1 : j], j + 1
			}
			return q[from+1:], n
		}
		j := from
		for j < n && !unicode.IsSpace(rune(q[j])) {
			j++
		}
		return q[from:j], j
	}

	for {
		skipSpace()
		if i >= n {
			break
		}
		// 偵測 operator 前綴（字母/數字/- 後接 ':'）
		j := i
		for j < n && isSearchKeyChar(q[j]) {
			j++
		}
		if j < n && q[j] == ':' {
			key := strings.ToLower(q[i:j])
			k := j + 1
			for k < n && unicode.IsSpace(rune(q[k])) {
				k++
			}
			val, next := readWord(k)
			if val != "" {
				tokens = append(tokens, searchToken{key: key, value: val})
				i = next
				continue
			}
			// operator 後無值 → 跌返落去當純文字
		}
		word, next := readWord(i)
		if word != "" {
			tokens = append(tokens, searchToken{value: word})
		}
		i = next
	}
	return tokens
}

// isIgnoredOperator 呢啲 operator 喺「目前資料夾內搜尋」語境下無意義（Gmail 係跨資料夾）
var ignoredOperators = map[string]bool{
	"in": true, "label": true, "category": true, "list": true, "filename": true,
}

// ParseSearchQuery 解析 Gmail 風格搜尋字串（支援引號、from:/to:/cc:/bcc:/subject:/body:/text:、
// is:unread/read/starred、has:attachment、after:/before:、larger:/smaller:）
func ParseSearchQuery(query string) *SearchQuery {
	pq := &SearchQuery{}
	for _, t := range tokenizeSearch(query) {
		switch t.key {
		case "":
			pq.Text = append(pq.Text, t.value)
		case "from":
			pq.From = append(pq.From, t.value)
		case "to":
			pq.To = append(pq.To, t.value)
		case "cc":
			pq.Cc = append(pq.Cc, t.value)
		case "bcc":
			pq.Bcc = append(pq.Bcc, t.value)
		case "subject":
			pq.Subject = append(pq.Subject, t.value)
		case "body":
			pq.Body = append(pq.Body, t.value)
		case "text":
			pq.Text = append(pq.Text, t.value)
		case "is":
			switch normalizeOpValue(t.value) {
			case "unread", "new":
				pq.Unread = true
			case "read", "seen":
				pq.Read = true
			case "starred", "flagged", "important":
				pq.Starred = true
			}
		case "has":
			switch normalizeOpValue(t.value) {
			case "attachment", "attach":
				pq.HasAttach = true
			case "star", "starred":
				pq.Starred = true
			case "unread":
				pq.Unread = true
			}
		case "after", "newer":
			if d, ok := parseSearchDate(t.value); ok {
				pq.After = d
			}
		case "before", "older":
			if d, ok := parseSearchDate(t.value); ok {
				pq.Before = d
			}
		case "larger", "size":
			if v, ok := parseSearchSize(t.value); ok {
				pq.Larger = v
			}
		case "smaller":
			if v, ok := parseSearchSize(t.value); ok {
				pq.Smaller = v
			}
		default:
			// 唔識嘅 operator → 當純文字（但 folder/scope 類 operator 忽略）
			if !ignoredOperators[t.key] {
				pq.Text = append(pq.Text, t.value)
			}
		}
	}
	return pq
}

func normalizeOpValue(s string) string {
	return strings.ToLower(strings.TrimSpace(s))
}

// buildSearchCriteria 解析 query 並產生 IMAP criteria；query 為空或無有效條件時返回 nil。
// bool 表示用到 has:attachment（伺服器可能唔支援）。
func buildSearchCriteria(query string) (*imap.SearchCriteria, bool) {
	pq := ParseSearchQuery(query)
	if pq.IsEmpty() {
		return nil, false
	}
	c, usesAttachment := pq.BuildCriteria()
	return c, usesAttachment
}

// buildSearchCriteriaNoAttachment 構建撇除 has:attachment 嘅 criteria（唔會因 keyword 報錯）
func buildSearchCriteriaNoAttachment(query string) (*imap.SearchCriteria, bool) {
	pq := ParseSearchQuery(query)
	if pq.IsEmpty() {
		return nil, false
	}
	c, _ := pq.BuildCriteriaNoAttachment()
	return c, false
}

// matchesText 判斷字串同任一關鍵字（唔理大小寫）有交集
func matchesText(s string, subs []string) bool {
	s = strings.ToLower(s)
	for _, sub := range subs {
		if sub == "" {
			continue
		}
		if strings.Contains(s, strings.ToLower(sub)) {
			return true
		}
	}
	return false
}

// MatchesNode 客戶端降級過濾（thread 模式）：只針到 index 有嘅欄位
// （subject / from / unread / read / starred / date）。body/to/cc/attachment 無法喺節點判定，
// 因此嗰啲條件喺降級模式啋唔會 match。
func (q *SearchQuery) MatchesNode(n *threadNode) bool {
	if q.IsEmpty() {
		return true
	}
	nodeFrom := func(field string) bool {
		for _, fe := range n.summary.From {
			if strings.Contains(strings.ToLower(fe.Address), strings.ToLower(field)) ||
				strings.Contains(strings.ToLower(fe.Name), strings.ToLower(field)) {
				return true
			}
		}
		return false
	}
	for _, kw := range q.Text {
		if !matchesText(n.subject, []string{kw}) && !nodeFrom(kw) {
			return false
		}
	}
	for _, v := range q.From {
		if !nodeFrom(v) {
			return false
		}
	}
	for _, v := range q.Subject {
		if !matchesText(n.subject, []string{v}) {
			return false
		}
	}
	if q.Unread && !n.summary.Unread {
		return false
	}
	if q.Read && n.summary.Unread {
		return false
	}
	if q.Starred && !n.summary.Starred {
		return false
	}
	if !q.After.IsZero() && n.date.Before(q.After) {
		return false
	}
	if !q.Before.IsZero() && n.date.After(q.Before) {
		return false
	}
	return true
}

func parseSearchDate(s string) (time.Time, bool) {
	s = strings.TrimSpace(s)
	if s == "" {
		return time.Time{}, false
	}
	for _, layout := range []string{
		"2006-01-02", "2006/01/02", "2006-1-2", "2006/1/2", "2006-01-02 15:04",
	} {
		if t, err := time.Parse(layout, s); err == nil {
			return t, true
		}
	}
	return time.Time{}, false
}

func parseSearchSize(s string) (int64, bool) {
	s = strings.TrimSpace(strings.ToUpper(s))
	if s == "" {
		return 0, false
	}
	mult := int64(1)
	switch s[len(s)-1] {
	case 'K', 'M', 'G':
		switch s[len(s)-1] {
		case 'K':
			mult = 1024
		case 'M':
			mult = 1024 * 1024
		case 'G':
			mult = 1024 * 1024 * 1024
		}
		s = s[:len(s)-1]
	case 'B':
		s = s[:len(s)-1]
	}
	num, err := strconv.ParseFloat(strings.TrimSpace(s), 64)
	if err != nil {
		return 0, false
	}
	return int64(num * float64(mult)), true
}
