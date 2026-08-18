package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base32"
	"encoding/hex"
	"fmt"
	"strings"

	"github.com/pquerna/otp"
	"github.com/pquerna/otp/totp"
)

const (
	Issuer            = "Modern Webmail"
	BackupCodeCharset = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
	BackupCodeCount   = 10
	BackupCodeGroups  = 2
	BackupCodeLen     = 5
)

// GenerateSecret 產生一個標準 base32 TOTP secret（不帶 padding）
func GenerateSecret() string {
	raw := make([]byte, 20)
	if _, err := rand.Read(raw); err != nil {
		panic("failed to generate random secret: " + err.Error())
	}
	return strings.TrimRight(base32.StdEncoding.EncodeToString(raw), "=")
}

// GenerateKey 產生 TOTP Key，包含 otpauth:// URI。
// secret 為 GenerateSecret 產出嘅 base32 字串。pquerna 預期 raw bytes 並自行
// base32 encode 入 URI；直接傳入 base32 字串會令 URI secret double-encoded，
// 與 Google Authenticator（及 oathtool）計出嘅 code 不一致，故需先 decode。
func GenerateKey(accountName, secret string) (*otp.Key, error) {
	raw, err := base32.StdEncoding.WithPadding(base32.NoPadding).DecodeString(secret)
	if err != nil {
		return nil, fmt.Errorf("invalid base32 secret: %w", err)
	}
	return totp.Generate(totp.GenerateOpts{
		Issuer:      Issuer,
		AccountName: accountName,
		Secret:      raw,
		Period:      30,
		Digits:      otp.DigitsSix,
		Algorithm:   otp.AlgorithmSHA1,
	})
}

// ValidateCode 驗證 TOTP code（允許 ±1 時間窗以容忍時鐘漂移）
func ValidateCode(secret, code string) bool {
	if secret == "" || code == "" {
		return false
	}
	code = strings.TrimSpace(code)
	return totp.Validate(code, secret)
}

// GenerateBackupCodes 產生一組一次性備份碼，並回傳明文與其 SHA-256 hash
func GenerateBackupCodes() (plain []string, hashed []string) {
	for i := 0; i < BackupCodeCount; i++ {
		code := randomBackupCode()
		plain = append(plain, code)
		hashed = append(hashed, HashCode(code))
	}
	return plain, hashed
}

// ValidateBackupCode 比對備份碼 hash，回傳命中索引（-1 表示無效）
func ValidateBackupCode(code string, hashes []string) int {
	code = strings.ToUpper(strings.TrimSpace(code))
	target := HashCode(code)
	for i, h := range hashes {
		if h == target {
			return i
		}
	}
	return -1
}

// HashCode 計算備份碼的 SHA-256 十六進位 hash
func HashCode(code string) string {
	sum := sha256.Sum256([]byte(strings.ToUpper(strings.TrimSpace(code))))
	return hex.EncodeToString(sum[:])
}

func randomBackupCode() string {
	const alphabet = BackupCodeCharset
	var sb strings.Builder
	for g := 0; g < BackupCodeGroups; g++ {
		if g > 0 {
			sb.WriteByte('-')
		}
		for i := 0; i < BackupCodeLen; i++ {
			sb.WriteByte(alphabet[randByte(len(alphabet))])
		}
	}
	return sb.String()
}

func randByte(max int) int {
	buf := make([]byte, 1)
	for {
		if _, err := rand.Read(buf); err != nil {
			continue
		}
		v := int(buf[0])
		if v < 256-(256%max) {
			return v % max
		}
	}
}

// FormatCode 格式化驗證碼輸入（去除空白，保留字母數字）
func FormatCode(raw string) string {
	var sb strings.Builder
	for _, r := range strings.ToUpper(strings.TrimSpace(raw)) {
		if r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' {
			sb.WriteRune(r)
		}
	}
	return sb.String()
}

// ValidateCodeInput 檢查使用者輸入是否為有效的 6 位數 TOTP 或備份碼格式
func IsBackupCodeShape(code string) bool {
	return len(FormatCode(code)) == BackupCodeGroups*BackupCodeLen
}
