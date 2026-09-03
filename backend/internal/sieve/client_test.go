package sieve

import (
	"bufio"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"math/big"
	"net"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"
)

// fakeDovecot 模擬真實 Dovecot managesieve-login 的「無 tag」行協議：
// 明文 banner（"STARTTLS" 帶引號、"SASL" ""）→ STARTTLS → 等 CAPABILITY
// → TLS banner（"SASL" "PLAIN"）→ AUTH → LISTSCRIPTS
func fakeDovecot(t *testing.T) (addr string, creds func() (string, string)) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	cert := selfSignedCert(t)
	var gotUser, gotPass string

	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer func() { _ = conn.Close() }()
		r := bufio.NewReader(conn)

		send := func(lines ...string) {
			for _, l := range lines {
				_, _ = conn.Write([]byte(l + "\r\n"))
			}
		}
		recv := func() []string {
			line, err := r.ReadString('\n')
			if err != nil {
				return nil
			}
			return strings.Fields(strings.TrimSpace(line))
		}

		send(
			`"IMPLEMENTATION" "Dovecot Pigeonhole"`,
			`"SIEVE" "fileinto reject envelope vacation spamtest"`,
			`"NOTIFY" "mailto"`,
			`"SASL" ""`,
			`"STARTTLS"`,
			`"VERSION" "1.0"`,
			`OK "Dovecot ready."`,
		)

		// STARTTLS（無 tag）
		f := recv()
		if len(f) == 0 || !strings.EqualFold(f[0], "STARTTLS") {
			return
		}
		send(`OK "Begin TLS negotiation now."`)

		tlsConn := tls.Server(conn, &tls.Config{Certificates: []tls.Certificate{cert}})
		if err := tlsConn.Handshake(); err != nil {
			return
		}
		conn = tlsConn
		r = bufio.NewReader(conn)

		// 真實 Dovecot：TLS 完成後自動推送新 capabilities banner（等唔需要 client 發 CAPABILITY）
		send(
			`"IMPLEMENTATION" "Dovecot Pigeonhole"`,
			`"SIEVE" "fileinto reject envelope vacation spamtest"`,
			`"NOTIFY" "mailto"`,
			`"SASL" "PLAIN"`,
			`"VERSION" "1.0"`,
			`OK "TLS negotiation successful."`,
		)

		// AUTHENTICATE "PLAIN" "<base64>"
		f = recv()
		if len(f) < 3 || !strings.EqualFold(f[0], "AUTHENTICATE") {
			return
		}
		b64 := strings.Trim(f[2], `"`)
		raw, err := base64.StdEncoding.DecodeString(b64)
		if err != nil {
			send(`NO "bad base64"`)
			return
		}
		parts := strings.Split(string(raw), "\x00")
		if len(parts) != 3 {
			send(`NO "bad PLAIN token"`)
			return
		}
		gotUser, gotPass = parts[1], parts[2]
		send(`OK "Logged in."`)

		// LISTSCRIPTS
		f = recv()
		if len(f) == 0 || !strings.EqualFold(f[0], "LISTSCRIPTS") {
			return
		}
		send(`"managesieve"`)
		send(`"test" ACTIVE`)
		send(`OK "Listscripts completed."`)
	}()

	return ln.Addr().String(), func() (string, string) { return gotUser, gotPass }
}

func selfSignedCert(t *testing.T) tls.Certificate {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: "localhost"},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		DNSNames:     []string{"localhost"},
		IPAddresses:  []net.IP{net.ParseIP("127.0.0.1")},
	}
	der, err := x509.CreateCertificate(rand.Reader, &tmpl, &tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}
}

func splitHostPort(t *testing.T, addr string) (string, int) {
	t.Helper()
	host, p, err := net.SplitHostPort(addr)
	if err != nil {
		t.Fatal(err)
	}
	port, err := strconv.Atoi(p)
	if err != nil {
		t.Fatal(err)
	}
	return host, port
}

// TestDialQuotedSTARTTLS 重現真實故障場景：Dovecot 帶引號 "STARTTLS" +
// 無 tag 協議；客戶端必須正確 STARTTLS 並完成認證與列表。
func TestDialQuotedSTARTTLS(t *testing.T) {
	addr, creds := fakeDovecot(t)
	host, port := splitHostPort(t, addr)

	client, err := Dial(context.Background(), Config{
		Host:             host,
		Port:             port,
		UseTLS:           true,
		AllowInsecureTLS: true,
		Username:         "johnw@example.com",
		Password:         "s3cret",
	})
	if err != nil {
		t.Fatalf("Dial failed: %v", err)
	}
	defer func() { _ = client.Close() }()

	u, p := creds()
	if u != "johnw@example.com" || p != "s3cret" {
		t.Fatalf("server received wrong credentials: user=%q pass=%q", u, p)
	}

	scripts, err := client.ListScripts()
	if err != nil {
		t.Fatalf("ListScripts failed: %v", err)
	}
	if len(scripts) != 2 {
		t.Fatalf("expected 2 scripts, got %d", len(scripts))
	}
	var active string
	for _, s := range scripts {
		if s.Active {
			active = s.Name
		}
	}
	if active != "test" {
		t.Fatalf("expected active test, got %q (scripts=%v)", active, scripts)
	}
}

func TestParseCapLineQuotedVariants(t *testing.T) {
	c := &Client{caps: map[string]string{}}
	parseCapLine(c, `"STARTTLS"`)
	if !c.tlsCap {
		t.Fatal(`quoted "STARTTLS" must set tlsCap`)
	}
	c2 := &Client{caps: map[string]string{}}
	parseCapLine(c2, "STARTTLS")
	if !c2.tlsCap {
		t.Fatal("bare STARTTLS must set tlsCap")
	}
	c3 := &Client{caps: map[string]string{}}
	parseCapLine(c3, `"SASL" ""`)
	if len(c3.sasl) != 0 {
		t.Fatalf("empty SASL should yield no mechanisms, got %v", c3.sasl)
	}
	c4 := &Client{caps: map[string]string{}}
	parseCapLine(c4, `"SASL" "PLAIN"`)
	if len(c4.sasl) != 1 || c4.sasl[0] != "PLAIN" {
		t.Fatalf("SASL parse failed: %v", c4.sasl)
	}
}

func TestIsFinalLine(t *testing.T) {
	ok := []string{"OK \"ready.\"", "NO (NONEXISTENT) \"x\"", "BAD bad", "OK [CAPABILITY] done"}
	notOK := []string{`"dummy" ACTIVE`, `"SIEVE" "fileinto"`, "+ cGxhaW4", ""}
	for _, s := range ok {
		if !isFinalLine(s) {
			t.Errorf("isFinalLine(%q) = false, want true", s)
		}
	}
	for _, s := range notOK {
		if isFinalLine(s) {
			t.Errorf("isFinalLine(%q) = true, want false", s)
		}
	}
}

// TestAgainstRealDovecot 只在有本地 Dovecot 容器時執行：
//
//	SIEVE_IT_HOST=127.0.0.1 SIEVE_IT_PORT=14190 SIEVE_IT_USER=.. SIEVE_IT_PASS=.. go test ./internal/sieve/ -run RealDovecot
func TestAgainstRealDovecot(t *testing.T) {
	host := os.Getenv("SIEVE_IT_HOST")
	if host == "" {
		t.Skip("SIEVE_IT_HOST not set")
	}
	port, _ := strconv.Atoi(os.Getenv("SIEVE_IT_PORT"))
	client, err := Dial(context.Background(), Config{
		Host:             host,
		Port:             port,
		UseTLS:           true,
		AllowInsecureTLS: true,
		Username:         os.Getenv("SIEVE_IT_USER"),
		Password:         os.Getenv("SIEVE_IT_PASS"),
		Debug:            true,
	})
	if err != nil {
		t.Fatalf("Dial against real Dovecot failed: %v", err)
	}
	defer func() { _ = client.Close() }()

	script := "if header :contains \"Subject\" \"x\" {\n  stop;\n}\n"
	if err := client.PutScript("e2mailit", script); err != nil {
		t.Fatalf("PutScript failed: %v", err)
	}
	if err := client.SetActive("e2mailit"); err != nil {
		t.Fatalf("SetActive failed: %v", err)
	}
	scripts, err := client.ListScripts()
	if err != nil {
		t.Fatalf("ListScripts failed: %v", err)
	}
	found := false
	for _, s := range scripts {
		if s.Name == "e2mailit" && s.Active {
			found = true
		}
	}
	if !found {
		t.Fatalf("e2mailit not active in %v", scripts)
	}
	got, err := client.GetScript("e2mailit")
	if err != nil {
		t.Fatalf("GetScript failed: %v", err)
	}
	if got != script {
		t.Fatalf("GetScript mismatch: %q", got)
	}
	// Dovecot 拒絕刪除 active 腳本（NO (ACTIVE)），必須先停用
	if err := client.SetActive(""); err != nil {
		t.Fatalf("SetActive(\"\") failed: %v", err)
	}
	if err := client.DeleteScript("e2mailit"); err != nil {
		t.Fatalf("DeleteScript failed: %v", err)
	}
}
