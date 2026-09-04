package ldap

import (
	"crypto/sha1" //nolint:gosec // SSHA 格式測試
	"crypto/sha256"
	"crypto/sha512"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
	"testing"

	goldap "github.com/go-ldap/ldap/v3"

	"github.com/johnwmail/e2mail/backend/internal/config"
)

// ===== {SSHA} =====

func TestFormatSSHA_CanonicalLayout(t *testing.T) {
	pw := "S3cr3t-Pässwörd!"
	salt := []byte("0123456789abcdef") // 16 bytes

	got := formatSSHA(pw, salt)
	if !strings.HasPrefix(got, "{SSHA}") {
		t.Fatalf("missing {SSHA} prefix: %q", got)
	}
	raw, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(got, "{SSHA}"))
	if err != nil {
		t.Fatalf("payload not valid base64: %v", err)
	}
	// canonical: SHA1(pw||salt)[20] || salt[16] = 36 bytes
	if len(raw) != sha1.Size+len(salt) {
		t.Fatalf("decoded len = %d, want %d", len(raw), sha1.Size+len(salt))
	}
	h := sha1.New()
	h.Write([]byte(pw))
	h.Write(salt)
	if got, want := raw[:sha1.Size], h.Sum(nil); string(got) != string(want) {
		t.Fatalf("digest mismatch")
	}
	if string(raw[sha1.Size:]) != string(salt) {
		t.Fatalf("trailing salt mismatch")
	}
}

func TestHashSSHA_RandomSaltPerCall(t *testing.T) {
	a, err := HashSSHA("samepass")
	if err != nil {
		t.Fatal(err)
	}
	b, err := HashSSHA("samepass")
	if err != nil {
		t.Fatal(err)
	}
	if a == b {
		t.Fatal("two HashSSHA of same password should differ (random salt)")
	}
	if !strings.HasPrefix(a, "{SSHA}") || !strings.HasPrefix(b, "{SSHA}") {
		t.Fatal("prefix missing")
	}
}

func TestClientHashPassword_Scheme(t *testing.T) {
	c := New(config.LDAPConfig{PasswordScheme: "sha"})
	if _, err := c.HashPassword("x"); err == nil {
		t.Fatal("scheme 'sha' should be rejected")
	}
	c = New(config.LDAPConfig{PasswordScheme: "SSHA"}) // case-insensitive
	got, err := c.HashPassword("x")
	if err != nil || !strings.HasPrefix(got, "{SSHA}") {
		t.Fatalf("ssha scheme: %q, %v", got, err)
	}
	c = New(config.LDAPConfig{PasswordScheme: "ssha256"})
	got, err = c.HashPassword("x")
	if err != nil || !strings.HasPrefix(got, "{SSHA256}") {
		t.Fatalf("ssha256 scheme: %q, %v", got, err)
	}
	c = New(config.LDAPConfig{PasswordScheme: "ssha512"})
	got, err = c.HashPassword("x")
	if err != nil || !strings.HasPrefix(got, "{SSHA512}") {
		t.Fatalf("ssha512 scheme: %q, %v", got, err)
	}
	c = New(config.LDAPConfig{PasswordScheme: "rfc3062"})
	if _, err := c.HashPassword("x"); err == nil {
		t.Fatal("rfc3062 must not pre-hash")
	}
}

func TestFormatSSHA256_CanonicalLayout(t *testing.T) {
	pw := "S3cr3t-Pässwörd!"
	salt := []byte("0123456789abcdef")
	got := formatSSHA256(pw, salt)
	if !strings.HasPrefix(got, "{SSHA256}") {
		t.Fatalf("prefix: %q", got)
	}
	raw, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(got, "{SSHA256}"))
	if err != nil {
		t.Fatal(err)
	}
	if len(raw) != sha256.Size+len(salt) {
		t.Fatalf("decoded len = %d, want %d", len(raw), sha256.Size+len(salt))
	}
	h := sha256.New()
	h.Write([]byte(pw))
	h.Write(salt)
	if string(raw[:sha256.Size]) != string(h.Sum(nil)) {
		t.Fatal("digest mismatch")
	}
	if string(raw[sha256.Size:]) != string(salt) {
		t.Fatal("salt mismatch")
	}
}

func TestFormatSSHA512_CanonicalLayout(t *testing.T) {
	pw := "S3cr3t-Pässwörd!"
	salt := []byte("0123456789abcdef")
	got := formatSSHA512(pw, salt)
	raw, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(got, "{SSHA512}"))
	if err != nil {
		t.Fatal(err)
	}
	if len(raw) != sha512.Size+len(salt) {
		t.Fatalf("decoded len = %d, want %d", len(raw), sha512.Size+len(salt))
	}
	h := sha512.New()
	h.Write([]byte(pw))
	h.Write(salt)
	if string(raw[:sha512.Size]) != string(h.Sum(nil)) {
		t.Fatal("digest mismatch")
	}
}

// ===== UserDN =====

func TestUserDN_Template(t *testing.T) {
	c := New(config.LDAPConfig{UserDNTemplate: `uid=%s,ou=people,dc=example,dc=com`})
	dn, err := c.UserDN("alice@example.com")
	if err != nil {
		t.Fatal(err)
	}
	if want := `uid=alice@example.com,ou=people,dc=example,dc=com`; dn != want {
		t.Fatalf("dn = %q, want %q", dn, want)
	}
}

func TestUserDN_LocalPartAndEscaping(t *testing.T) {
	c := New(config.LDAPConfig{UserDNTemplate: `%u`})
	dn, err := c.UserDN(`a+b,c@example.com`)
	if err != nil {
		t.Fatal(err)
	}
	if dn != `a\+b\,c` {
		t.Fatalf("local part escape = %q", dn)
	}

	c2 := New(config.LDAPConfig{UserDNTemplate: `uid=%s,ou=x`})
	dn2, _ := c2.UserDN(`we"ird@x.com`)
	if !strings.Contains(dn2, `we\"ird`) {
		t.Fatalf("full email escape = %q", dn2)
	}
}

func TestUserDN_NoReexpansion(t *testing.T) {
	// email 內含字面 "%u" 時不得被二次展開
	c := New(config.LDAPConfig{UserDNTemplate: `cn=%s,o=%u`})
	dn, err := c.UserDN(`a%ub@x.com`)
	if err != nil {
		t.Fatal(err)
	}
	if want := `cn=a%ub@x.com,o=a%ub`; dn != want {
		t.Fatalf("dn = %q, want %q", dn, want)
	}
}

// ===== fake Conn 行為 =====

type recordedCall struct {
	dn   string
	pass string
}

type fakeConn struct {
	bindErr            error
	modifyErr          error
	passwordModifyErr  error
	binds              []recordedCall
	changes            []recordedCall // dn + 修改值（userPassword 寫入值）
	passwordModifies   []recordedCall // userIdentity + newPassword
}

func (f *fakeConn) Bind(username, password string) error {
	f.binds = append(f.binds, recordedCall{username, password})
	return f.bindErr
}

func (f *fakeConn) Modify(req *goldap.ModifyRequest) error {
	val := ""
	if len(req.Changes) > 0 {
		if len(req.Changes[0].Modification.Vals) > 0 {
			val = req.Changes[0].Modification.Vals[0]
		}
		if got := req.Changes[0].Modification.Type; got != "userPassword" {
			return fmt.Errorf("unexpected attribute %q", got)
		}
	}
	f.changes = append(f.changes, recordedCall{req.DN, val})
	return f.modifyErr
}

func (f *fakeConn) PasswordModify(req *goldap.PasswordModifyRequest) (*goldap.PasswordModifyResult, error) {
	f.passwordModifies = append(f.passwordModifies, recordedCall{req.UserIdentity, req.NewPassword})
	return &goldap.PasswordModifyResult{}, f.passwordModifyErr
}

func (f *fakeConn) Close() error { return nil }

func newTestClient(opts config.LDAPConfig, conn *fakeConn) *Client {
	c := New(opts)
	c.dial = func() (Conn, error) { return conn, nil }
	return c
}

func ldapErr(code uint16) error {
	return goldap.NewError(code, errors.New("simulated"))
}

func TestVerifyUserBind_OK(t *testing.T) {
	f := &fakeConn{}
	c := newTestClient(config.LDAPConfig{}, f)
	if err := c.VerifyUserBind("uid=a,dc=x", "pw"); err != nil {
		t.Fatal(err)
	}
	if len(f.binds) != 1 || f.binds[0].dn != "uid=a,dc=x" || f.binds[0].pass != "pw" {
		t.Fatalf("binds = %+v", f.binds)
	}
}

func TestVerifyUserBind_InvalidCredentialsMapping(t *testing.T) {
	f := &fakeConn{bindErr: ldapErr(goldap.LDAPResultInvalidCredentials)}
	c := newTestClient(config.LDAPConfig{}, f)
	err := c.VerifyUserBind("uid=a,dc=x", "wrong")
	if !errors.Is(err, ErrInvalidCredentials) {
		t.Fatalf("want ErrInvalidCredentials, got %v", err)
	}
}

func TestVerifyUserBind_OtherErrorNotInvalid(t *testing.T) {
	f := &fakeConn{bindErr: ldapErr(goldap.LDAPResultServerDown)}
	c := newTestClient(config.LDAPConfig{}, f)
	if err := c.VerifyUserBind("uid=a,dc=x", "p"); errors.Is(err, ErrInvalidCredentials) {
		t.Fatalf("server-down must not map to ErrInvalidCredentials: %v", err)
	}
}

func TestChangePassword_RootBindAndSSHAModify(t *testing.T) {
	f := &fakeConn{}
	c := newTestClient(config.LDAPConfig{
		RootDN: "cn=root,dc=example,dc=com",
		RootPW: "rootpw",
	}, f)
	if err := c.ChangePassword("uid=alice,ou=people,dc=example,dc=com", "NewPass123"); err != nil {
		t.Fatal(err)
	}
	if len(f.binds) != 1 || f.binds[0].dn != "cn=root,dc=example,dc=com" || f.binds[0].pass != "rootpw" {
		t.Fatalf("root bind calls = %+v", f.binds)
	}
	if len(f.changes) != 1 {
		t.Fatalf("changes = %+v", f.changes)
	}
	if f.changes[0].dn != "uid=alice,ou=people,dc=example,dc=com" {
		t.Fatalf("modify DN = %q", f.changes[0].dn)
	}
	if !strings.HasPrefix(f.changes[0].pass, "{SSHA}") {
		t.Fatalf("modify value not {SSHA}: %q", f.changes[0].pass)
	}
}

func TestChangePassword_RootBindFailure(t *testing.T) {
	f := &fakeConn{bindErr: ldapErr(goldap.LDAPResultInvalidCredentials)}
	c := newTestClient(config.LDAPConfig{RootDN: "cn=root", RootPW: "bad"}, f)
	err := c.ChangePassword("uid=a", "x")
	if !errors.Is(err, ErrInvalidCredentials) {
		t.Fatalf("want ErrInvalidCredentials wrapped, got %v", err)
	}
	if len(f.changes) != 0 {
		t.Fatal("must not modify after failed root bind")
	}
}

func TestChangePassword_SSHA256Modify(t *testing.T) {
	f := &fakeConn{}
	c := newTestClient(config.LDAPConfig{
		RootDN:         "cn=root",
		RootPW:         "pw",
		PasswordScheme: "ssha256",
	}, f)
	if err := c.ChangePassword("uid=alice,dc=x", "NewPass123"); err != nil {
		t.Fatal(err)
	}
	if len(f.passwordModifies) != 0 {
		t.Fatal("ssha256 must use Modify, not RFC 3062")
	}
	if len(f.changes) != 1 || !strings.HasPrefix(f.changes[0].pass, "{SSHA256}") {
		t.Fatalf("changes = %+v", f.changes)
	}
}

func TestChangePassword_RFC3062(t *testing.T) {
	f := &fakeConn{}
	c := newTestClient(config.LDAPConfig{
		RootDN:         "cn=root,dc=example,dc=com",
		RootPW:         "rootpw",
		PasswordScheme: "rfc3062",
	}, f)
	const userDN = "uid=alice,ou=people,dc=example,dc=com"
	const newPass = "NewPass123"
	if err := c.ChangePassword(userDN, newPass); err != nil {
		t.Fatal(err)
	}
	if len(f.changes) != 0 {
		t.Fatalf("rfc3062 must not Modify userPassword: %+v", f.changes)
	}
	if len(f.passwordModifies) != 1 {
		t.Fatalf("passwordModifies = %+v", f.passwordModifies)
	}
	if f.passwordModifies[0].dn != userDN || f.passwordModifies[0].pass != newPass {
		t.Fatalf("extended op payload = %+v", f.passwordModifies[0])
	}
}

func TestChangePassword_RFC3062_Failure(t *testing.T) {
	f := &fakeConn{passwordModifyErr: ldapErr(goldap.LDAPResultUnwillingToPerform)}
	c := newTestClient(config.LDAPConfig{RootDN: "cn=root", RootPW: "pw", PasswordScheme: "rfc3062"}, f)
	err := c.ChangePassword("uid=a", "x")
	if err == nil {
		t.Fatal("want error")
	}
}

func TestChangePassword_ModifyFailureNotSwallowed(t *testing.T) {
	f := &fakeConn{modifyErr: ldapErr(goldap.LDAPResultInsufficientAccessRights)}
	c := newTestClient(config.LDAPConfig{RootDN: "cn=root", RootPW: "pw"}, f)
	err := c.ChangePassword("uid=a", "x")
	if err == nil {
		t.Fatal("want error")
	}
	if errors.Is(err, ErrInvalidCredentials) {
		t.Fatal("access denied is not invalid-credentials")
	}
}
