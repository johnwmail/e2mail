package handler

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"strings"

	"github.com/ProtonMail/go-crypto/openpgp"
	"github.com/ProtonMail/go-crypto/openpgp/armor"
	"modern-webmail/backend/internal/storage"
	"modern-webmail/backend/pkg/response"
)

// ImportContactsRequest 接收由前端上傳的公鑰檔原始內容（已轉為 UTF-8 字串）
type ImportContactsRequest struct {
	Armored string `json:"armored"`
}

// ImportContacts 解析使用者上傳的公鑰檔（單一 armored 區塊或已分段），回傳儲存結果
// 此端點作為前端 openpgp.js 在大檔案（≥4MB 多公鑰）情境下解析失敗的 fallback
func (h *ContactsHandler) ImportContacts(w http.ResponseWriter, r *http.Request) {
	owner, ok := h.ownerFromCtx(r)
	if !ok {
		response.Unauthorized(w, "unauthorized session")
		return
	}

	var req ImportContactsRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		log.Printf("[IMPORT] %s: bad json: %v", owner, err)
		response.BadRequest(w, "invalid json body: "+err.Error())
		return
	}

	armored := strings.TrimSpace(req.Armored)
	log.Printf("[IMPORT] %s: received armored content length=%d", owner, len(armored))
	if armored == "" {
		log.Printf("[IMPORT] %s: empty armored content", owner)
		response.BadRequest(w, "armored 內容為空")
		return
	}

	var entityList openpgp.EntityList
	var err error
	entityList, err = openpgp.ReadArmoredKeyRing(strings.NewReader(armored))
	if err != nil && !errors.Is(err, io.EOF) {
		log.Printf("[IMPORT] %s: ReadArmoredKeyRing failed: %v — trying ReadKeyRing", owner, err)
		entityList, err = openpgp.ReadKeyRing(strings.NewReader(armored))
		if err != nil {
			log.Printf("[IMPORT] %s: ReadKeyRing failed: %v", owner, err)
			response.BadRequest(w, "無法解析公鑰檔: "+err.Error())
			return
		}
	}
	log.Printf("[IMPORT] %s: parsed %d entities", owner, len(entityList))

	contacts := make([]storage.ContactKey, 0, len(entityList))
	invalid := 0
	seen := make(map[string]bool)
	for _, entity := range entityList {
		if entity == nil {
			continue
		}
		if entity.PrivateKey != nil {
			invalid++
			continue
		}

		var primaryEmail, primaryName string
		for _, ident := range entity.Identities {
			if ident == nil {
				continue
			}
			primaryEmail = ident.UserId.Email
			primaryName = ident.UserId.Name
			break
		}
		if primaryEmail == "" {
			invalid++
			continue
		}
		primaryEmail = strings.ToLower(strings.TrimSpace(primaryEmail))
		primaryName = strings.TrimSpace(primaryName)

		if seen[primaryEmail] {
			invalid++
			continue
		}
		seen[primaryEmail] = true

		var buf bytes.Buffer
		aw, err := armor.Encode(&buf, openpgp.PublicKeyType, nil)
		if err != nil {
			log.Printf("[IMPORT] %s: armor.Encode failed for %s: %v", owner, primaryEmail, err)
			invalid++
			continue
		}
		if err := entity.Serialize(aw); err != nil {
			log.Printf("[IMPORT] %s: entity.Serialize failed for %s: %v", owner, primaryEmail, err)
			_ = aw.Close()
			invalid++
			continue
		}
		if err := aw.Close(); err != nil {
			log.Printf("[IMPORT] %s: armored writer close failed for %s: %v", owner, primaryEmail, err)
			invalid++
			continue
		}

		fingerprint := strings.ToUpper(entity.PrimaryKey.KeyIdString())
		keyId := strings.ToUpper(entity.PrimaryKey.KeyIdShortString())

		contacts = append(contacts, storage.ContactKey{
			OwnerEmail:   owner,
			ContactEmail: primaryEmail,
			Name:         primaryName,
			Fingerprint:  fingerprint,
			KeyID:        keyId,
			ArmoredKey:   buf.String(),
		})
	}

	log.Printf("[IMPORT] %s: built %d contacts, invalid=%d", owner, len(contacts), invalid)

	if len(contacts) == 0 {
		response.Success(w, map[string]any{
			"saved":   0,
			"skipped": []string{},
			"invalid": invalid,
		})
		return
	}

	saved, skippedList, err := h.store.BulkUpsertContacts(owner, contacts)
	if err != nil {
		log.Printf("[IMPORT] %s: bulk save failed: %v", owner, err)
		response.InternalServerError(w, "failed to bulk save contacts: "+err.Error())
		return
	}
	log.Printf("[IMPORT] %s: saved=%d skipped=%d invalid=%d", owner, saved, len(skippedList), invalid)

	response.Success(w, map[string]any{
		"saved":   saved,
		"skipped": skippedList,
		"invalid": invalid,
	})
}
