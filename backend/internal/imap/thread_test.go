package imap

import (
	"testing"
)

func TestSubjectKey(t *testing.T) {
	cases := map[string]string{
		"Re: Re: [tag] Fwd: Hello": "hello",
		"答复：部署問題":                  "部署問題",
		"RE(2): Meeting":           "meeting",
		"(no subject)":             "",
		"   ":                      "",
		"Plain subject":            "plain subject",
		"Fwd: Re: A":               "a",
	}
	for in, want := range cases {
		got := subjectKey(in)
		if got != want {
			t.Errorf("subjectKey(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestNormalizeMsgID(t *testing.T) {
	got := normalizeMsgID(" <ABC@Example.com > ")
	if got != "abc@example.com" {
		t.Errorf("normalizeMsgID = %q", got)
	}
}

func TestParseReferencesHeader(t *testing.T) {
	raw := "References: <a@x> <b@y>\r\n\t<c@z>\r\nSubject: hi\r\n"
	refs := parseReferencesHeader(raw)
	if len(refs) != 3 || refs[0] != "a@x" || refs[1] != "b@y" || refs[2] != "c@z" {
		t.Fatalf("parseReferencesHeader = %v", refs)
	}
	if got := parseReferencesHeader("Subject: hi\r\n"); got != nil {
		t.Fatalf("no references should return nil, got %v", got)
	}
}

func TestGroupThreadsRefChain(t *testing.T) {
	inputs := []ThreadInput{
		{UID: 1, MessageID: "m1", Subject: "部署問題"},
		{UID: 2, MessageID: "m2", References: []string{"m1"}, Subject: "Re: 部署問題"},
		{UID: 3, MessageID: "m3", References: []string{"m1", "m2"}, Subject: "Re: Re: 部署問題"},
	}
	root := GroupThreads(inputs)
	if root[1] != root[2] || root[2] != root[3] {
		t.Fatalf("expected single thread, got roots %v", root)
	}
}

func TestGroupThreadsUnrelated(t *testing.T) {
	inputs := []ThreadInput{
		{UID: 1, MessageID: "a", Subject: "主題一"},
		{UID: 2, MessageID: "b", Subject: "主題二"},
	}
	root := GroupThreads(inputs)
	if root[1] == root[2] {
		t.Fatal("unrelated subjects must not merge")
	}
}

func TestGroupThreadsSubjectFallback(t *testing.T) {
	// 兩封都無 msgID/refs，同主題 → 併入一組
	inputs := []ThreadInput{
		{UID: 1, Subject: "Meeting notes"},
		{UID: 2, Subject: "Re: meeting notes"},
	}
	root := GroupThreads(inputs)
	if root[1] != root[2] {
		t.Fatalf("subject fallback failed: %v", root)
	}
}

func TestGroupThreadsCycle(t *testing.T) {
	// 循環引用唔應該 panic，併一組
	inputs := []ThreadInput{
		{UID: 1, MessageID: "x", References: []string{"y"}},
		{UID: 2, MessageID: "y", References: []string{"x"}},
	}
	root := GroupThreads(inputs)
	if root[1] != root[2] {
		t.Fatalf("cycle should form one group, got %v", root)
	}
}

func TestGroupThreadsNoSubjectNotMerged(t *testing.T) {
	inputs := []ThreadInput{
		{UID: 1, MessageID: "a", Subject: "(no subject)"},
		{UID: 2, MessageID: "b", Subject: ""},
	}
	root := GroupThreads(inputs)
	if root[1] == root[2] {
		t.Fatal("empty/no-subject messages must not merge by subject")
	}
}

func TestGroupThreadsInReplyTo(t *testing.T) {
	inputs := []ThreadInput{
		{UID: 1, MessageID: "root1"},
		{UID: 2, MessageID: "reply1", InReplyTo: "root1"},
	}
	root := GroupThreads(inputs)
	if root[1] != root[2] {
		t.Fatalf("InReplyTo link failed: %v", root)
	}
}
