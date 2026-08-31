package imap

import (
	"testing"
	"time"
)

func TestParseSearchQueryText(t *testing.T) {
	pq := ParseSearchQuery("hello world")
	if len(pq.Text) != 2 || pq.Text[0] != "hello" || pq.Text[1] != "world" {
		t.Fatalf("expected two text keywords, got %+v", pq.Text)
	}
	if pq.IsEmpty() {
		t.Fatal("expected not empty")
	}
}

func TestParseSearchQueryQuotedText(t *testing.T) {
	pq := ParseSearchQuery(`"hello world" foo`)
	if len(pq.Text) != 2 || pq.Text[0] != "hello world" || pq.Text[1] != "foo" {
		t.Fatalf("unexpected quoted parse: %+v", pq.Text)
	}
}

func TestParseSearchQueryOperators(t *testing.T) {
	pq := ParseSearchQuery(`from:alice@example.com to:bob@example.com cc:carol@example.com bcc:dan@example.com subject:"meet up" body:agenda`)
	if len(pq.From) != 1 || pq.From[0] != "alice@example.com" {
		t.Fatalf("from: %+v", pq.From)
	}
	if len(pq.To) != 1 || pq.To[0] != "bob@example.com" {
		t.Fatalf("to: %+v", pq.To)
	}
	if len(pq.Cc) != 1 || pq.Cc[0] != "carol@example.com" {
		t.Fatalf("cc: %+v", pq.Cc)
	}
	if len(pq.Bcc) != 1 || pq.Bcc[0] != "dan@example.com" {
		t.Fatalf("bcc: %+v", pq.Bcc)
	}
	if len(pq.Subject) != 1 || pq.Subject[0] != "meet up" {
		t.Fatalf("subject: %+v", pq.Subject)
	}
	if len(pq.Body) != 1 || pq.Body[0] != "agenda" {
		t.Fatalf("body: %+v", pq.Body)
	}
}

func TestParseSearchQueryFlags(t *testing.T) {
	pq := ParseSearchQuery("is:unread is:starred has:attachment")
	if !pq.Unread {
		t.Fatal("expected unread true")
	}
	if !pq.Starred {
		t.Fatal("expected starred true")
	}
	if !pq.HasAttach {
		t.Fatal("expected hasAttachment true")
	}
}

func TestParseSearchQueryIsReadAndInvalid(t *testing.T) {
	pq := ParseSearchQuery("is:read is:zzz has:nope")
	if !pq.Read {
		t.Fatal("expected read true")
	}
	if pq.Unread || pq.Starred || pq.HasAttach {
		t.Fatalf("unexpected flags: %+v", pq)
	}
}

func TestParseSearchQueryDates(t *testing.T) {
	pq := ParseSearchQuery("after:2024-01-15 before:2024-03-01")
	if pq.After.IsZero() || pq.After.Year() != 2024 || pq.After.Month() != 1 || pq.After.Day() != 15 {
		t.Fatalf("after wrong: %v", pq.After)
	}
	if pq.Before.IsZero() || pq.Before.Year() != 2024 || pq.Before.Month() != 3 || pq.Before.Day() != 1 {
		t.Fatalf("before wrong: %v", pq.Before)
	}
}

func TestParseSearchQuerySizes(t *testing.T) {
	pq := ParseSearchQuery("larger:2048 smaller:1M")
	if pq.Larger != 2048 {
		t.Fatalf("larger wrong: %d", pq.Larger)
	}
	if pq.Smaller != 1024*1024 {
		t.Fatalf("smaller wrong: %d", pq.Smaller)
	}
}

func TestParseSearchQueryIgnoredOperators(t *testing.T) {
	pq := ParseSearchQuery("in:archive label:foo")
	if !pq.IsEmpty() {
		t.Fatalf("only ignored operators should be empty: %+v", pq)
	}
	if len(pq.Text) != 0 {
		t.Fatalf("ignored operators should not become text: %+v", pq.Text)
	}
	// 被忽略嘅 operator 唔會變成純文字，但普通字詞仍然會保留
	pq2 := ParseSearchQuery("in:archive foo")
	if pq2.IsEmpty() {
		t.Fatal("expected not empty (foo is text)")
	}
	if len(pq2.Text) != 1 || pq2.Text[0] != "foo" {
		t.Fatalf("text should keep foo: %+v", pq2.Text)
	}
}

func TestBuildCriteriaCombines(t *testing.T) {
	pq := ParseSearchQuery("is:unread from:alice@example.com")
	criteria, usesAtt := pq.BuildCriteria()
	if criteria == nil {
		t.Fatal("criteria nil")
	}
	if usesAtt {
		t.Fatal("should not use attachment")
	}
	if len(criteria.NotFlag) != 1 || criteria.NotFlag[0] != "\\Seen" {
		t.Fatalf("notflag: %+v", criteria.NotFlag)
	}
	foundFrom := false
	for _, h := range criteria.Header {
		if h.Key == "From" && h.Value == "alice@example.com" {
			foundFrom = true
		}
	}
	if !foundFrom {
		t.Fatalf("from header not in criteria: %+v", criteria.Header)
	}
}

func TestBuildCriteriaAttachmentRetry(t *testing.T) {
	pq := ParseSearchQuery("has:attachment")
	criteria, usesAtt := pq.BuildCriteria()
	if !usesAtt {
		t.Fatal("expected usesAttachment")
	}
	if len(criteria.Flag) != 1 || criteria.Flag[0] != "\\HasAttachment" {
		t.Fatalf("attachment flag wrong: %+v", criteria.Flag)
	}
	c2, usesAtt2 := pq.BuildCriteriaNoAttachment()
	if usesAtt2 {
		t.Fatal("no-attachment variant should not use attachment")
	}
	if c2 != nil && len(c2.Flag) != 0 {
		t.Fatalf("no-attachment variant should not have flag: %+v", c2.Flag)
	}
}

func TestMatchesNode(t *testing.T) {
	node := &threadNode{subject: "Project X meeting", date: time.Date(2024, 2, 1, 0, 0, 0, 0, time.UTC)}
	node.summary.Unread = true
	node.summary.Starred = true
	node.summary.From = append(node.summary.From, EmailAddress{Address: "alice@example.com", Name: "Alice"})

	tests := []struct {
		query string
		want  bool
	}{
		{"meeting", true},
		{"nomatch", false},
		{"subject:project x", true},
		{"from:alice", true},
		{"from:bob", false},
		{"is:unread", true},
		{"is:read", false},
		{"is:starred", true},
		{"after:2024-01-01", true},
		{"before:2023-01-01", false},
	}
	for _, tt := range tests {
		pq := ParseSearchQuery(tt.query)
		if got := pq.MatchesNode(node); got != tt.want {
			t.Errorf("MatchesNode(%q) = %v, want %v", tt.query, got, tt.want)
		}
	}
}

func TestTokenizeSearchEdgeCases(t *testing.T) {
	toks := tokenizeSearch(`subject:"hello world" from:alice plain text`)
	if len(toks) != 4 {
		t.Fatalf("expected 4 tokens, got %d: %+v", len(toks), toks)
	}
	if toks[0].key != "subject" || toks[0].value != "hello world" {
		t.Fatalf("token0: %+v", toks[0])
	}
	if toks[1].key != "from" || toks[1].value != "alice" {
		t.Fatalf("token1: %+v", toks[1])
	}
	if toks[2].value != "plain" || toks[3].value != "text" {
		t.Fatalf("tokens 2-3: %+v", toks[2:])
	}
}
