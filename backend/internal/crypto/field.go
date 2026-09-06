package crypto

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strings"
)

// 欄位編碼前綴（見 docs/ENCRYPTION.md §4）：
//
//	"e1:" + base64(AES-GCM(DEK, plaintext))  ← 正式密文
const FieldEncPrefix = "e1:"

// ErrFieldEncoding 未知欄位編碼
var ErrFieldEncoding = errors.New("crypto: unknown field encoding")

// HashID 對任意字串算 sha256 hex（大小寫敏感，適合 IMAP folder 名稱）
func HashID(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

// OwnerID email → DB 盲索引：lower+trim 後 sha256 hex（與 handler.normalizeEmail 一致）
func OwnerID(email string) string {
	return HashID(strings.ToLower(strings.TrimSpace(email)))
}

// WrapField 以 DEK 加密欄位值
func WrapField(dek []byte, plain string) (string, error) {
	if plain == "" {
		return "", nil
	}
	if len(dek) == 0 {
		return "", errors.New("dek required")
	}
	enc, err := Encrypt(dek, []byte(plain))
	if err != nil {
		return "", err
	}
	return FieldEncPrefix + enc, nil
}

// UnwrapField 讀欄位值（e1: 用 DEK 解密）
func UnwrapField(dek []byte, stored string) (string, error) {
	switch {
	case stored == "":
		return "", nil
	case strings.HasPrefix(stored, FieldEncPrefix):
		dec, err := Decrypt(dek, strings.TrimPrefix(stored, FieldEncPrefix))
		if err != nil {
			return "", err
		}
		return string(dec), nil
	default:
		return "", ErrFieldEncoding
	}
}
