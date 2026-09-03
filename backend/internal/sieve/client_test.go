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
	"strconv"
	"strings"
	"testing"
	"time"
)

// fakeDovecot 模擬 Dovecot Pigeonhole ManageSieve：
// 明文 banner（"STARTTLS" 帶引號、"SASL" ""）→ STARTTLS → TLS banner（"SASL" "PLAIN"）→ AUTH → LISTSCRIPTS
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

		// 1) 明文 banner（用戶 telnet 所見：全部帶引號，SASL 空）
		send(
			`"IMPLEMENTATION" "Dovecot Pigeonhole"`,
			`"SIEVE" "fileinto reject envelope vacation spamtest"`,
			`"NOTIFY" "mailto"`,
			`"SASL" ""`,
			`"STARTTLS"`,
			`"VERSION" "1.0"`,
			`OK "Dovecot ready."`,
		)

		// 2) 等 STARTTLS
		line, err := r.ReadString('\n')
		if err != nil {
			return
		}
		fields := strings.Fields(strings.TrimSpace(line))
		if len(fields) < 2 || !strings.EqualFold(fields[1], "STARTTLS") {
			send(fields[0] + ` BAD "Unknown command"` + "\r\n")
			return
		}
		send(fields[0] + ` OK "Begin TLS negotiation now."`)

		tlsConn := tls.Server(conn, &tls.Config{Certificates: []tls.Certificate{cert}})
		if err := tlsConn.Handshake(); err != nil {
			return
		}
		conn = tlsConn
		r = bufio.NewReader(conn)

		// 2.5) 按 RFC 5804：TLS 後等 client 主動發 CAPABILITY（唔會 push banner）
		line, err = r.ReadString('\n')
		if err != nil {
			return
		}
		fields = strings.Fields(strings.TrimSpace(line))
		if len(fields) < 2 || !strings.EqualFold(fields[1], "CAPABILITY") {
			return
		}
		send(`"SASL" "PLAIN"`)
		send(fields[0] + ` OK "CAPABILITY completed."`)

		// 3) AUTHENTICATE "PLAIN" "base64"
		line, err = r.ReadString('\n')
		if err != nil {
			return
		}
		fields = strings.Fields(strings.TrimSpace(line))
		if len(fields) < 4 || !strings.EqualFold(fields[1], "AUTHENTICATE") {
			if len(fields) > 0 {
				send(fields[0] + ` NO "Expected AUTHENTICATE, got garbage"` + "\r\n")
			}
			return
		}
		b64 := strings.Trim(fields[3], `"`)
		// base40（RFC 5804）：若以 '=' 結尾，先剝掉一個多餘的 '='
		if strings.HasSuffix(b64, "=") {
			b64 = strings.TrimSuffix(b64, "=")
		}
		raw, err := base64.StdEncoding.DecodeString(b64)
		if err != nil {
			send(fields[0] + ` NO "bad base64"` + "\r\n")
			return
		}
		parts := strings.Split(string(raw), "\x00") // ["", user, pass]
		if len(parts) != 3 {
			send(fields[0] + ` NO "bad PLAIN token"` + "\r\n")
			return
		}
		gotUser, gotPass = parts[1], parts[2]
		send(fields[0] + ` OK "Logged in."`)

		// 4) LISTSCRIPTS
		line, err = r.ReadString('\n')
		if err != nil {
			return
		}
		fields = strings.Fields(strings.TrimSpace(line))
		if len(fields) < 2 || !strings.EqualFold(fields[1], "LISTSCRIPTS") {
			return
		}
		send(`"managesieve.sieve"`)
		send(`"test.sieve" ACTIVE`)
		send(fields[0] + ` OK "LISTSCRIPTS complete."`)

		// 5) LOGOUT / 結束
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

// TestDialQuotedSTARTTLS 重現真實故障：Dovecot 以「帶引號」形式發送 "STARTTLS"，
// 舊版 parseCapLine 不會設 tlsCap → 客戶端跳過 STARTTLS → 永遠收不到 SASL 機制。
func TestDialQuotedSTARTTLS(t *testing.T) {
	addr, creds := fakeDovecot(t)
	host, port := splitHostPort(t, addr)

	client, err := Dial(context.Background(), Config{
		Host:             host,
		Port:             port,
		UseTLS:           true,
		AllowInsecureTLS: true, // 自簽
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
	if active != "test.sieve" {
		t.Fatalf("expected active test.sieve, got %q (scripts=%v)", active, scripts)
	}
}

func TestParseCapLineQuotedVariants(t *testing.T) {
	c := &Client{caps: map[string]string{}}
	parseCapLine(c, `"STARTTLS"`)
	if !c.tlsCap {
		t.Fatal("quoted \"STARTTLS\" must set tlsCap")
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
