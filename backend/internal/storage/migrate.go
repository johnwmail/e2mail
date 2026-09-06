package storage

import (
	"database/sql"
	"errors"
	"fmt"
	"log"
	"time"

	"github.com/johnwmail/e2mail/backend/internal/crypto"
)

// ENCRYPTION.md §5：全字段加密之 schema 遷移與 lazy 轉換。
//
// v1→v2：owner email → owner_id 盲索引（sha256）；內容欄 → pending（p:）包裹，
// 待該 owner 首次登入（DEK 可用）由 EncryptPendingFields 轉為 e1: DEK 密文。
// 單一事務；失敗自動 rollback，DB 停留 v1（fail closed）。完成後 VACUUM 清走
// 舊明文頁殘留（含 WAL checkpoint）。
//
// 注意：v1 兩段式嘅 sentinel/migration 代碼為一次性；待 §6.6 審計殘量=0 後
// 按 ENCRYPTION.md §5.3 徹底移除（M5 cleanup）。

// pendingWrap 用 nil-DEK WrapField 產生 p: 標記
func pendingWrap(plain string) (string, error) { return crypto.WrapField(nil, plain) }

// isLegacySchema 偵測 v1 schema（accounts 表有 user_email 欄）
func isLegacySchema(db *sql.DB) (bool, error) {
	var cnt int
	if err := db.QueryRow(`SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='accounts'`).Scan(&cnt); err != nil {
		return false, err
	}
	if cnt == 0 {
		return false, nil // 全新 DB
	}
	if err := db.QueryRow(`SELECT COUNT(*) FROM pragma_table_info('accounts') WHERE name='user_email'`).Scan(&cnt); err != nil {
		return false, err
	}
	return cnt > 0, nil
}

// tableExists 檢查表存在（v1 DB 可能冇部分表）
func tableExists(db *sql.DB, name string) (bool, error) {
	var cnt int
	if err := db.QueryRow(`SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?`, name).Scan(&cnt); err != nil {
		return false, err
	}
	return cnt > 0, nil
}

func migrateV1toV2(db *sql.DB) error {
	return migrateV1toV2WithHook(db, nil)
}

// migrateV1toV2WithHook：beforeCommit 僅供測試注入「事務內寫入失敗」情境（rollback 驗證）。
//nolint:gocyclo // 遷移需逐表處理多分支與碰撞合併，拆分會降低可讀性
func migrateV1toV2WithHook(db *sql.DB, beforeCommit func() error) error {
	start := time.Now()

	// 舊至 v1 嘅 accounts 可能冇 sieve 欄（向後兼容 ALTER，冪等）
	for _, ddl := range []string{
		`ALTER TABLE accounts ADD COLUMN sieve_host TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE accounts ADD COLUMN sieve_port INTEGER NOT NULL DEFAULT 0`,
		`ALTER TABLE accounts ADD COLUMN sieve_use_tls INTEGER NOT NULL DEFAULT 1`,
		`ALTER TABLE accounts ADD COLUMN sieve_allow_insecure_tls INTEGER NOT NULL DEFAULT 0`,
	} {
		_, _ = db.Exec(ddl)
	}

	// 1. 讀全部 v1 數據到 memory（mail DB 細表；資料只喺 transaction 內移動）
	type row map[string]any

	readRows := func(table, cols string) ([]row, error) {
		ok, err := tableExists(db, table)
		if err != nil || !ok {
			return nil, err
		}
		rows, err := db.Query(`SELECT ` + cols + ` FROM ` + table)
		if err != nil {
			return nil, fmt.Errorf("read %s: %w", table, err)
		}
		defer func() { _ = rows.Close() }()
		colsList := splitCols(cols)
		var out []row
		for rows.Next() {
			vals := make([]any, len(colsList))
			ptrs := make([]any, len(colsList))
			for i := range vals {
				ptrs[i] = &vals[i]
			}
			if err := rows.Scan(ptrs...); err != nil {
				return nil, fmt.Errorf("scan %s: %w", table, err)
			}
			r := row{}
			for i, c := range colsList {
				r[c] = vals[i]
			}
			out = append(out, r)
		}
		return out, rows.Err()
	}

	str := func(r row, k string) string {
		if v, ok := r[k]; ok && v != nil {
			if b, isB := v.([]byte); isB {
				return string(b)
			}
			if s, isS := v.(string); isS {
				return s
			}
			return fmt.Sprint(v)
		}
		return ""
	}
	i64 := func(r row, k string) int64 {
		if v, ok := r[k]; ok && v != nil {
			switch n := v.(type) {
			case int64:
				return n
			case int:
				return int64(n)
			}
		}
		return 0
	}

	users, err := readRows("users", "owner_email, salt, wrapped_dek, created_at, updated_at")
	if err != nil {
		return err
	}
	twofas, err := readRows("two_fa", "owner_email, secret, backup_code_hashes, enabled_at")
	if err != nil {
		return err
	}
	keyrings, err := readRows("personal_keyrings", "owner_email, public_key_armored, encrypted_private_key, fingerprint, key_id, updated_at")
	if err != nil {
		return err
	}
	accounts, err := readRows("accounts", `id, user_email, label, email,
		imap_host, imap_port, imap_use_tls, imap_allow_insecure_tls,
		smtp_host, smtp_port, smtp_use_tls, smtp_allow_insecure_tls,
		sieve_host, sieve_port, sieve_use_tls, sieve_allow_insecure_tls,
		username, enc_imap_password, enc_smtp_password,
		is_default, sort_order, created_at, updated_at`)
	if err != nil {
		return err
	}
	contacts, err := readRows("contacts", "id, owner_email, email, display_name, given_name, family_name, avatar_path, note, source, created_at, updated_at")
	if err != nil {
		return err
	}
	contactKeys, err := readRows("contact_keys", "owner_email, contact_email, name, fingerprint, key_id, armored_key, created_at")
	if err != nil {
		return err
	}
	folderPrefs, err := readRows("folder_prefs", "user_email, account_id, folder_name, visible")
	if err != nil {
		return err
	}
	folderOrder, err := readRows("folder_order", "account_id, folder_name, sort_index")
	if err != nil {
		return err
	}
	userPrefs, err := readRows("user_prefs", "owner_email, pref_key, pref_value, updated_at")
	if err != nil {
		return err
	}

	// account_id → owner_id（folder_order 舊表冇 owner 欄，靠 accounts 映射；孤兒 row 丟棄）
	ownerByAccount := map[string]string{}
	for _, a := range accounts {
		ownerByAccount[str(a, "id")] = crypto.OwnerID(str(a, "user_email"))
	}

	// 2. 單一事務重建
	tx, err := db.Begin()
	if err != nil {
		return fmt.Errorf("begin migration tx: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	dropAll := `
		DROP TABLE IF EXISTS users; DROP TABLE IF EXISTS two_fa; DROP TABLE IF EXISTS personal_keyrings;
		DROP TABLE IF EXISTS accounts; DROP TABLE IF EXISTS contacts; DROP TABLE IF EXISTS contact_keys;
		DROP TABLE IF EXISTS folder_prefs; DROP TABLE IF EXISTS folder_order; DROP TABLE IF EXISTS user_prefs;`
	if _, err := tx.Exec(dropAll); err != nil {
		return fmt.Errorf("drop v1 tables: %w", err)
	}
	if _, err := tx.Exec(schema); err != nil {
		return fmt.Errorf("create v2 schema: %w", err)
	}

	pending := 0

	// users（大細寫碰撞保最新 updated_at）
	bestUser := map[string]row{}
	for _, u := range users {
		oid := crypto.OwnerID(str(u, "owner_email"))
		if cur, ok := bestUser[oid]; ok && i64(cur, "updated_at") >= i64(u, "updated_at") {
			log.Printf("[MIGRATE] WARNING merge users row for owner_id=%s (case-variant collision)", oid[:12])
			continue
		}
		bestUser[oid] = u
	}
	for oid, u := range bestUser {
		if _, err := tx.Exec(
			`INSERT INTO users (owner_id, salt, wrapped_dek, pending_encrypt, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)`,
			oid, []byte(str(u, "salt")), str(u, "wrapped_dek"), i64(u, "created_at"), i64(u, "updated_at")); err != nil {
			return fmt.Errorf("migrate users: %w", err)
		}
	}

	// two_fa
	bestTwoFA := map[string]row{}
	for _, t := range twofas {
		oid := crypto.OwnerID(str(t, "owner_email"))
		if cur, ok := bestTwoFA[oid]; ok && i64(cur, "enabled_at") >= i64(t, "enabled_at") {
			log.Printf("[MIGRATE] WARNING merge two_fa row for owner_id=%s", oid[:12])
			continue
		}
		bestTwoFA[oid] = t
	}
	for oid, t := range bestTwoFA {
		bh := str(t, "backup_code_hashes")
		if bh == "" {
			bh = "[]"
		}
		if _, err := tx.Exec(`INSERT INTO two_fa (owner_id, secret, backup_code_hashes, enabled_at) VALUES (?, ?, ?, ?)`,
			oid, str(t, "secret"), bh, i64(t, "enabled_at")); err != nil {
			return fmt.Errorf("migrate two_fa: %w", err)
		}
	}

	// personal_keyrings（private 欄保留原 DEK 密文；其餘 pending）
	for _, k := range keyrings {
		pub, err2 := pendingWrap(str(k, "public_key_armored"))
		if err2 != nil {
			return err2
		}
		fp, err2 := pendingWrap(str(k, "fingerprint"))
		if err2 != nil {
			return err2
		}
		kid, err2 := pendingWrap(str(k, "key_id"))
		if err2 != nil {
			return err2
		}
		oid := crypto.OwnerID(str(k, "owner_email"))
		if _, err := tx.Exec(`INSERT INTO personal_keyrings (owner_id, public_key_armored, encrypted_private_key, fingerprint, key_id, updated_at) VALUES (?, ?, ?, ?, ?, ?)
			ON CONFLICT(owner_id) DO UPDATE SET public_key_armored=excluded.public_key_armored, encrypted_private_key=excluded.encrypted_private_key, fingerprint=excluded.fingerprint, key_id=excluded.key_id, updated_at=excluded.updated_at`,
			oid, pub, str(k, "encrypted_private_key"), fp, kid, i64(k, "updated_at")); err != nil {
			return fmt.Errorf("migrate keyring: %w", err)
		}
		pending += 3
	}

	// accounts（內容欄 pending；密碼欄原樣搬移）
	for _, a := range accounts {
		w, err2 := wrapPending(
			str(a, "label"), str(a, "email"), str(a, "imap_host"),
			str(a, "smtp_host"), str(a, "sieve_host"), str(a, "username"))
		if err2 != nil {
			return err2
		}
		pending += 6
		if _, err := tx.Exec(
			`INSERT INTO accounts (id, owner_id, label, email,
				imap_host, imap_port, imap_use_tls, imap_allow_insecure_tls,
				smtp_host, smtp_port, smtp_use_tls, smtp_allow_insecure_tls,
				sieve_host, sieve_port, sieve_use_tls, sieve_allow_insecure_tls,
				username, enc_imap_password, enc_smtp_password,
				is_default, sort_order, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(id) DO UPDATE SET owner_id=excluded.owner_id, label=excluded.label, email=excluded.email,
				imap_host=excluded.imap_host, smtp_host=excluded.smtp_host, sieve_host=excluded.sieve_host, username=excluded.username`,
			str(a, "id"), crypto.OwnerID(str(a, "user_email")), w[0], w[1], w[2], i64(a, "imap_port"), i64(a, "imap_use_tls"), i64(a, "imap_allow_insecure_tls"),
			w[3], i64(a, "smtp_port"), i64(a, "smtp_use_tls"), i64(a, "smtp_allow_insecure_tls"),
			w[4], i64(a, "sieve_port"), i64(a, "sieve_use_tls"), i64(a, "sieve_allow_insecure_tls"),
			w[5], str(a, "enc_imap_password"), str(a, "enc_smtp_password"),
			i64(a, "is_default"), i64(a, "sort_order"), i64(a, "created_at"), i64(a, "updated_at")); err != nil {
			return fmt.Errorf("migrate account: %w", err)
		}
	}

	// contacts（碰撞保最新 updated_at）
	bestContact := map[string]row{}
	for _, c := range contacts {
		key := crypto.OwnerID(str(c, "owner_email")) + "|" + emailIndex(str(c, "email"))
		if cur, ok := bestContact[key]; ok && i64(cur, "updated_at") >= i64(c, "updated_at") {
			log.Printf("[MIGRATE] WARNING merge contacts row %s", str(c, "id"))
			continue
		}
		bestContact[key] = c
	}
	for key, c := range bestContact {
		w, err2 := wrapPending(
			str(c, "email"), str(c, "display_name"), str(c, "given_name"),
			str(c, "family_name"), str(c, "note"), str(c, "source"))
		if err2 != nil {
			return err2
		}
		pending += 6
		if _, err := tx.Exec(
			`INSERT INTO contacts (id, owner_id, email_hash, email, display_name, given_name, family_name, avatar_path, note, source, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			str(c, "id"), key[:64], key[65:], w[0], w[1], w[2], w[3], str(c, "avatar_path"), w[4], w[5],
			i64(c, "created_at"), i64(c, "updated_at")); err != nil {
			return fmt.Errorf("migrate contact: %w", err)
		}
	}

	// contact_keys（碰撞保最新 created_at）
	bestCK := map[string]row{}
	for _, c := range contactKeys {
		key := crypto.OwnerID(str(c, "owner_email")) + "|" + emailIndex(str(c, "contact_email"))
		if cur, ok := bestCK[key]; ok && i64(cur, "created_at") >= i64(c, "created_at") {
			log.Printf("[MIGRATE] WARNING merge contact_keys row for %s", key[:12])
			continue
		}
		bestCK[key] = c
	}
	for key, c := range bestCK {
		w, err2 := wrapPending(
			str(c, "contact_email"), str(c, "name"), str(c, "fingerprint"),
			str(c, "key_id"), str(c, "armored_key"))
		if err2 != nil {
			return err2
		}
		pending += 5
		if _, err := tx.Exec(
			`INSERT INTO contact_keys (owner_id, email_hash, contact_email, name, fingerprint, key_id, armored_key, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			key[:64], key[65:], w[0], w[1], w[2], w[3], w[4], i64(c, "created_at")); err != nil {
			return fmt.Errorf("migrate contact_key: %w", err)
		}
	}

	// folder_prefs（name_hash 碰撞保最後可見值）
	bestFP := map[string]row{}
	for _, f := range folderPrefs {
		key := crypto.OwnerID(str(f, "user_email")) + "|" + str(f, "account_id") + "|" + nameIndex(str(f, "folder_name"))
		bestFP[key] = f
	}
	for key, f := range bestFP {
		oid, acc, nh, _ := split3(key)
		fn, err2 := pendingWrap(str(f, "folder_name"))
		if err2 != nil {
			return err2
		}
		pending++
		if _, err := tx.Exec(`INSERT INTO folder_prefs (owner_id, account_id, name_hash, folder_name, visible) VALUES (?, ?, ?, ?, ?)`,
			oid, acc, nh, fn, i64(f, "visible")); err != nil {
			return fmt.Errorf("migrate folder_pref: %w", err)
		}
	}

	// folder_order：靠 accounts 映射出 owner；孤兒（帳號已刪）丟棄
	for _, f := range folderOrder {
		oid, ok := ownerByAccount[str(f, "account_id")]
		if !ok {
			continue
		}
		fn, err2 := pendingWrap(str(f, "folder_name"))
		if err2 != nil {
			return err2
		}
		pending++
		if _, err := tx.Exec(`INSERT INTO folder_order (owner_id, account_id, name_hash, folder_name, sort_index) VALUES (?, ?, ?, ?, ?)`,
			oid, str(f, "account_id"), nameIndex(str(f, "folder_name")), fn, i64(f, "sort_index")); err != nil {
			return fmt.Errorf("migrate folder_order: %w", err)
		}
	}

	// user_prefs（pref_key 明文留，值 pending）
	bestUP := map[string]row{}
	for _, p := range userPrefs {
		key := crypto.OwnerID(str(p, "owner_email")) + "|" + str(p, "pref_key")
		if cur, ok := bestUP[key]; ok && i64(cur, "updated_at") >= i64(p, "updated_at") {
			continue
		}
		bestUP[key] = p
	}
	for key, p := range bestUP {
		pv, err2 := pendingWrap(str(p, "pref_value"))
		if err2 != nil {
			return err2
		}
		pending++
		if _, err := tx.Exec(`INSERT INTO user_prefs (owner_id, pref_key, pref_value, updated_at) VALUES (?, ?, ?, ?)`,
			key[:64], key[65:], pv, i64(p, "updated_at")); err != nil {
			return fmt.Errorf("migrate user_pref: %w", err)
		}
	}

	if beforeCommit != nil {
		if err := beforeCommit(); err != nil {
			return fmt.Errorf("migration aborted (rollback): %w", err)
		}
	}
	if _, err := tx.Exec(`PRAGMA user_version = 2`); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit migration: %w", err)
	}

	// 3. VACUUM + checkpoint：抹走舊明文 page 殘留（DB 檔 + WAL）
	if _, err := db.Exec(`VACUUM`); err != nil {
		log.Printf("[MIGRATE] WARNING vacuum failed (plaintext residue may remain in old pages): %v", err)
	}
	if _, err := db.Exec(`PRAGMA wal_checkpoint(TRUNCATE)`); err != nil {
		log.Printf("[MIGRATE] WARNING wal_checkpoint failed: %v", err)
	}
	log.Printf("[MIGRATE] field-encryption v2 applied: users=%d accounts=%d contacts=%d contact_keys=%d pending_fields≈%d in %s",
		len(bestUser), len(accounts), len(bestContact), len(bestCK), pending, time.Since(start).Round(time.Millisecond))
	return nil
}

func wrapPending(vals ...string) ([]string, error) {
	out := make([]string, len(vals))
	for i, v := range vals {
		w, err := pendingWrap(v)
		if err != nil {
			return nil, err
		}
		out[i] = w
	}
	return out, nil
}

func splitCols(cols string) []string {
	parts := []string{}
	cur := ""
	depth := 0
	for _, r := range cols {
		switch r {
		case '(':
			depth++
			cur += string(r)
		case ')':
			depth--
			cur += string(r)
		case ',':
			if depth == 0 {
				parts = append(parts, trimSpace(cur))
				cur = ""
			} else {
				cur += string(r)
			}
		default:
			cur += string(r)
		}
	}
	if trimSpace(cur) != "" {
		parts = append(parts, trimSpace(cur))
	}
	return parts
}

func trimSpace(s string) string {
	for len(s) > 0 && (s[0] == ' ' || s[0] == '\n' || s[0] == '\t') {
		s = s[1:]
	}
	for len(s) > 0 && (s[len(s)-1] == ' ' || s[len(s)-1] == '\n' || s[len(s)-1] == '\t') {
		s = s[:len(s)-1]
	}
	return s
}

// split3 拆 "oid|acc|hash"（皆為 hex/uuid，無分隔符風險）
func split3(key string) (string, string, string, string) {
	var out [4]string
	i := 0
	start := 0
	for j := 0; j < len(key) && i < 3; j++ {
		if key[j] == '|' {
			out[i] = key[start:j]
			i++
			start = j + 1
		}
	}
	out[i] = key[start:]
	return out[0], out[1], out[2], out[3]
}

// ===== Lazy 轉換（§5.2）與審計（§6.6）=====

type pendingTarget struct {
	table string
	key   string // PK WHERE template with owner/account condition
	cols  []string
}

func (s *SQLiteStore) pendingTargets(ownerID string) []pendingTarget {
	return []pendingTarget{
		{"accounts", "owner_id = '" + ownerID + "'", []string{"label", "email", "imap_host", "smtp_host", "sieve_host", "username"}},
		{"personal_keyrings", "owner_id = '" + ownerID + "'", []string{"public_key_armored", "fingerprint", "key_id"}},
		{"contact_keys", "owner_id = '" + ownerID + "'", []string{"contact_email", "name", "fingerprint", "key_id", "armored_key"}},
		{"contacts", "owner_id = '" + ownerID + "'", []string{"email", "display_name", "given_name", "family_name", "note", "source"}},
		{"folder_prefs", "owner_id = '" + ownerID + "'", []string{"folder_name"}},
		{"folder_order", "owner_id = '" + ownerID + "'", []string{"folder_name"}},
		{"user_prefs", "owner_id = '" + ownerID + "'", []string{"pref_value"}},
	}
}

// HasPendingEncrypt 查詢 owner 有無待轉換資料
func (s *SQLiteStore) HasPendingEncrypt(userEmail string) (bool, error) {
	var pending int
	err := s.db.QueryRow(`SELECT COALESCE(pending_encrypt, 0) FROM users WHERE owner_id = ?`, crypto.OwnerID(userEmail)).Scan(&pending)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return pending == 1, err
}

// EncryptPendingFields 將該 owner 全部 p: 欄位轉為 e1:（DEK 密文），並清除 pending 旗標。
// 冪等；失敗回滾並回傳 error（唔阻登入，下次再試）。
func (s *SQLiteStore) EncryptPendingFields(userEmail string, dek []byte) (int, error) {
	if len(dek) == 0 {
		return 0, errors.New("dek required")
	}
	ownerID := crypto.OwnerID(userEmail)
	converted := 0

	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback() }()

	for _, t := range s.pendingTargets(ownerID) {
		for _, col := range t.cols {
			rows, err := tx.Query(fmt.Sprintf(`SELECT rowid, %s FROM %s WHERE %s AND %s LIKE 'p:%%'`, col, t.table, t.key, col))
			if err != nil {
				return converted, fmt.Errorf("scan %s.%s: %w", t.table, col, err)
			}
			type upd struct {
				rowid int64
				value string
			}
			var upds []upd
			for rows.Next() {
				var rid int64
				var val string
				if err := rows.Scan(&rid, &val); err != nil {
					_ = rows.Close()
					return converted, err
				}
				upds = append(upds, upd{rid, val})
			}
			_ = rows.Close()
			if err := rows.Err(); err != nil {
				return converted, err
			}
			for _, u := range upds {
				plain, err := crypto.UnwrapPending(u.value)
				if err != nil {
					return converted, fmt.Errorf("unwrap %s.%s rowid=%d: %w", t.table, col, u.rowid, err)
				}
				enc, err := crypto.WrapField(dek, plain)
				if err != nil {
					return converted, err
				}
				if _, err := tx.Exec(fmt.Sprintf(`UPDATE %s SET %s = ? WHERE rowid = ?`, t.table, col), enc, u.rowid); err != nil {
					return converted, fmt.Errorf("update %s.%s: %w", t.table, col, err)
				}
				converted++
			}
		}
	}
	if _, err := tx.Exec(`UPDATE users SET pending_encrypt = 0 WHERE owner_id = ?`, ownerID); err != nil {
		return converted, err
	}
	if err := tx.Commit(); err != nil {
		return converted, err
	}
	return converted, nil
}

// CountPendingFields 全庫審計：剩餘 p: 欄位值數量 + pending owner 數（§6.6 管理員用）
func (s *SQLiteStore) CountPendingFields() (int, error) {
	total := 0
	all := []pendingTarget{
		{"accounts", "1=1", []string{"label", "email", "imap_host", "smtp_host", "sieve_host", "username"}},
		{"personal_keyrings", "1=1", []string{"public_key_armored", "fingerprint", "key_id"}},
		{"contact_keys", "1=1", []string{"contact_email", "name", "fingerprint", "key_id", "armored_key"}},
		{"contacts", "1=1", []string{"email", "display_name", "given_name", "family_name", "note", "source"}},
		{"folder_prefs", "1=1", []string{"folder_name"}},
		{"folder_order", "1=1", []string{"folder_name"}},
		{"user_prefs", "1=1", []string{"pref_value"}},
	}
	for _, t := range all {
		for _, col := range t.cols {
			var n int
			if err := s.db.QueryRow(fmt.Sprintf(`SELECT COUNT(*) FROM %s WHERE %s LIKE 'p:%%'`, t.table, col)).Scan(&n); err != nil {
				return total, err
			}
			total += n
		}
	}
	return total, nil
}
