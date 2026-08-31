package charsetutil

import (
	"bytes"
	"fmt"
	"io"
	"mime"
	"strings"
	"unicode/utf8"

	"golang.org/x/net/html/charset"
	"golang.org/x/text/encoding"
	"golang.org/x/text/encoding/charmap"
	"golang.org/x/text/encoding/htmlindex"
	"golang.org/x/text/encoding/japanese"
	"golang.org/x/text/encoding/simplifiedchinese"
	"golang.org/x/text/encoding/traditionalchinese"
	"golang.org/x/text/transform"
)

// DecodeHeader 解碼 RFC 2047 編碼字串（例如 =?UTF-8?B?...?= 或 =?Big5?B?...?=）
func DecodeHeader(input string) string {
	if input == "" {
		return ""
	}

	decoder := mime.WordDecoder{
		CharsetReader: func(charsetStr string, input io.Reader) (io.Reader, error) {
			return NewReader(input, charsetStr)
		},
	}

	decoded, err := decoder.DecodeHeader(input)
	if err != nil {
		return input
	}
	return decoded
}

// DecodeRFC2047 是 DecodeHeader 的別名，提供相容性
func DecodeRFC2047(input string) string {
	return DecodeHeader(input)
}

// GetEncoding 根據字元集名稱取得對應的 Encoding 實例
func GetEncoding(name string) (encoding.Encoding, error) {
	name = strings.TrimSpace(strings.ToLower(name))
	name = strings.Trim(name, `"'`)

	if name == "" || name == "utf-8" || name == "utf8" || name == "us-ascii" || name == "ascii" {
		return encoding.Nop, nil
	}

	// 常見編碼別名手動覆蓋
	switch name {
	case "big5", "big5-hkscs", "cp950", "windows-950":
		return traditionalchinese.Big5, nil
	case "gb2312", "gbk", "cp936", "windows-936":
		return simplifiedchinese.GBK, nil
	case "gb18030":
		return simplifiedchinese.GB18030, nil
	case "hz-gb-2312":
		return simplifiedchinese.HZGB2312, nil
	case "euc-jp":
		return japanese.EUCJP, nil
	case "iso-2022-jp":
		return japanese.ISO2022JP, nil
	case "shift_jis", "sjis", "cp932", "windows-31j":
		return japanese.ShiftJIS, nil
	case "windows-1252", "cp1252":
		return charmap.Windows1252, nil
	case "iso-8859-1", "latin1":
		return charmap.ISO8859_1, nil
	}

	// 嘗試從 htmlindex 獲取
	enc, err := htmlindex.Get(name)
	if err == nil && enc != nil {
		return enc, nil
	}

	return nil, fmt.Errorf("unsupported charset: %s", name)
}

// NewReader 將指定字元集的 io.Reader 轉為輸出 UTF-8 的 io.Reader
func NewReader(r io.Reader, charsetName string) (io.Reader, error) {
	charsetName = strings.TrimSpace(strings.ToLower(charsetName))
	if charsetName == "" || charsetName == "utf-8" || charsetName == "utf8" || charsetName == "us-ascii" || charsetName == "ascii" {
		return r, nil
	}

	enc, err := GetEncoding(charsetName)
	if err == nil && enc != nil {
		return transform.NewReader(r, enc.NewDecoder()), nil
	}

	// 嘗試 fallback 使用 html/charset
	rUtf8, err := charset.NewReaderLabel(charsetName, r)
	if err == nil {
		return rUtf8, nil
	}

	return r, nil
}

// ToUTF8 將指定字元集的 byte slice 轉換為 UTF-8 string
func ToUTF8(data []byte, charsetName string) (string, error) {
	if len(data) == 0 {
		return "", nil
	}

	// 若已為有效 UTF-8，直接返回，唔再解碼。
	//（go-message 經 CharsetReader 已可能做過 charset 轉換，呢度避免重複解碼搞亂）
	if utf8.Valid(data) {
		return string(data), nil
	}

	reader, err := NewReader(bytes.NewReader(data), charsetName)
	if err != nil {
		return string(data), err
	}

	buf := new(bytes.Buffer)
	_, err = io.Copy(buf, reader)
	if err != nil {
		return string(data), err
	}

	return buf.String(), nil
}
