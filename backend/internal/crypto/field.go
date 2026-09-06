package crypto

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"strings"
)

// 欄位編碼前綴（見 ENCRYPTION.md §4）：
//
//	"e1:" + base64(AES-GCM(DEK, plaintext))  ← 正式密文
//	"p:"  + base64(plaintext)                ← 遷移中的「待轉換」標記（lazy 轉換後消失）
//
// 明文以 base64 包裹，避免與真實內容（例如以 "p:" 開頭的備註）撞前綴。
const (
	FieldEncPrefix     = "e1:"
	FieldPendingPrefix = "p:"
)

// ErrFieldEncoding 未知欄位編碼（無前綴且非空 = DB 被外部改壞）
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

// PendingWrap 產生「待轉換」編碼（遷移/無 DEK 環境專用）
func PendingWrap(plain string) string {
	return FieldPendingPrefix + base64.StdEncoding.EncodeToString([]byte(plain))
}

// WrapField 以 DEK 加密欄位值；dek 空時退回 PendingWrap
func WrapField(dek []byte, plain string) (string, error) {
	if plain == "" {
		return "", nil
	}
	if len(dek) == 0 {
		return PendingWrap(plain), nil
	}
	enc, err := Encrypt(dek, []byte(plain))
	if err != nil {
		return "", err
	}
	return FieldEncPrefix + enc, nil
}

// UnwrapField 讀欄位值：e1: 用 DEK 解密；p: 直接解 base64（明文回傳，稍後由 lazy 步轉 e1:）
func UnwrapField(dek []byte, stored string) (string, error) {
	switch {
	case stored == "":
		return "", nil
	case strings.HasPrefix(stored, FieldPendingPrefix):
		dec, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(stored, FieldPendingPrefix))
		if err != nil {
			return "", ErrFieldEncoding
		}
		return string(dec), nil
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

// UnwrapPending 從 p: 值取出明文（lazy 轉換專用；非 p: 前綴回傳 error）
func UnwrapPending(stored string) (string, error) {
	if !strings.HasPrefix(stored, FieldPendingPrefix) {
		return "", ErrFieldEncoding
	}
	dec, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(stored, FieldPendingPrefix))
	if err != nil {
		return "", ErrFieldEncoding
	}
	return string(dec), nil
}
