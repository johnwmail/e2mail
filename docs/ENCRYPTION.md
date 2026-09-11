# ENCRYPTION.md — DB 全面加密設計（owner_id 盲索引 + DEK 內容加密）

> 狀態：**已實施並完成遷移**（`p:` 殘量已清零；M5 cleanup 已移除遷移／sentinel code，最終態僅 `owner_id` + `e1:`）。
> 目標：SQLite DB 檔被拷走後，除「盲索引 + 結構 metadata」外，**全部有意義內容需要用戶登入密碼先解到**。
> 相關文檔：`docs/LDAP.md`（MasterKey/DEK re-wrap）、`docs/MultiAccounts.md` §2（LUKS 式 envelope）、`docs/AGENTS.md`。

---

## 1. 決定（owner 已拍板，2026-09）

| 項目 | 決定 |
|---|---|
| 查詢鍵 | **裸 SHA-256(normalize(email))** 做 owner_id／聯絡人 email 索引 |
| Server key | **唔用**（明確否決 HMAC/field key）→ 接受 DB 持有者可枚舉驗證「email X 有帳號」 |
| 內容欄 | 全部以 **DEK（用戶密碼解鎖）** AES-GCM 加密 |
| 前端/API | **零改動**（API 照用明文 email，只係 DB 表示層變化） |
| 弱密碼警告 | UI 已有（login firstLoginHint），維持 |

Hash 算法揀 SHA-256 唔係 SHA-512：x86/ARM 有硬件指令（SHA-NI/ARMv8）、索引細一半、對「防逆推」根本無分別（email 低熵，邊個 hash 都照枚舉）。想改 SHA-512 只動一個函數。

---

## 2. 金鑰層級（新）

```
用戶密碼（從不儲存，只喺 login request 內存出現）
 └─ MasterKey = Argon2id(密碼, users.salt)          ← 現有
     └─ users.wrapped_dek = AES-GCM(MasterKey, DEK)  ← 現有
         └─ DEK（每用戶隨機 32B）
             ├─ 現有：IMAP/SMTP 密碼、2FA secret、PGP 私鑰
             └─ 新增：email／label／所有 host／username／
                      contacts 全部內容欄／keyring 公開欄／
                      folder name／user pref value

owner_id   = hex(SHA-256(lower(trim(email))))        ← DB 主鍵，非秘密
email_hash = 同上，用於聯絡人 email 等值查詢           ← 非秘密
```

Session（記憶體）維持現狀：`Session.Accounts` 嘅 label/email/hosts/username 係**明文**（登入時一次性解密後放嘅），所以 pool/sieve/smtp/mail/middleware 全部後段 code path **零改動**；只有 storage 邊界加解密。

---

## 3. 欄位級別：邊度加密、邊度留明文

### 3.1 新明文（DB 賊見到嘅全部）
- `owner_id` / `email_hash`（hash，不可逆，但可枚舉驗證）
- uuid `id`（accounts/contacts 主鍵，本身隨機）
- 端口 + TLS 旗標（imap/smtp/sieve port/use_tls/allow_insecure）
- `is_default`、`sort_order`、全部時間戳
- `users.salt`、`users.wrapped_dek`、`two_fa.backup_code_hashes`（已 hash）
- `user_prefs.pref_key`（`locale`/`list_mode` 等固定鍵名）、`visible`、`sort_index`
- 行數（某 owner 有幾多 contacts/accounts/folders）、`avatar_path`（純 uuid 檔名，無內容）

### 3.2 全部轉 DEK 密文（`e1:` 前綴，見 §4）
| 表 | 欄 |
|---|---|
| accounts | `label`、`email`、`username`、`imap_host`、`smtp_host`、`sieve_host` |
| contacts | `email`、`display_name`、`given_name`、`family_name`、`note`、`source` |
| contact_keys | `contact_email`（顯示值）、`name`、`key_id`、`fingerprint`、`armored_key` |
| personal_keyrings | `public_key_armored`、`fingerprint`、`key_id`（`encrypted_private_key` 本來已 DEK） |
| folder_prefs / folder_order | `folder_name` |
| user_prefs | `pref_value` |

### 3.3 查詢鍵改造（因內容加密，等值查詢改用 hash）
| 表 | 舊鍵 | 新鍵 |
|---|---|---|
| users / two_fa / personal_keyrings | `owner_email` PK | `owner_id` PK |
| accounts | `user_email` + idx | `owner_id` + idx |
| contacts | `UNIQUE(owner_email, email)` | `email_hash` 欄 + `UNIQUE(owner_id, email_hash)`（`idx(owner_id,email_hash)`） |
| contact_keys | `PK(owner_email, contact_email)` | `PK(owner_id, email_hash)` |
| folder_prefs | `PK(user_email, account_id, folder_name)` | `PK(owner_id, account_id, name_hash)` + `folder_name` 欄存密文 |
| folder_order | `PK(account_id, folder_name)`（冇 owner！） | `PK(account_id, name_hash)` + **新增 `owner_id` 欄**（解密需要） |
| user_prefs | `PK(owner_email, pref_key)` | `PK(owner_id, pref_key)` |

`SetFolderOrder`/`GetFolderOrder` 現時 WHERE 只用 account_id（冇 user_email）→ 新加 owner_id 條件（順手執漏）。

### 3.4 SQL LIKE 搜尋改記憶體
`ListAddressContacts` 嘅 `email/display_name/note LIKE %q%`：密文無法 LIKE → 改為：讀 owner 全部 contacts → 解密 → Go 內 case-insensitive substring filter（三欄）→ 按 display_name/email 排序 → Go 端 limit/offset。量級假設 ≤ 數千 contacts/owner（可接受；日後有需要先加快取）。

`ResolveAddressContacts(emails[])`：照常 — 用 `email_hash IN (...)` 等值查詢，回傳前解密。

---

## 4. 欄值編碼格式（新 helper）

```
"e1:" + base64( AES-GCM(DEK, plaintext) )   ← 正式密文
"p:"  + 明文                                 ← 遷移產生嘅「待加密」標記
""                                             ← 空值照空
無前綴 legacy base64                           ← 現有 enc_* 欄（已是 DEK 密文）
```

`backend/internal/crypto/field.go`（新檔）：

```go
func OwnerID(email string) string                  // lower+trim → sha256 hex
func IsPendingField(v string) bool                 // strings.HasPrefix(v, "p:")
func WrapField(dek []byte, plain string) (string, error)   // "e1:"+Encrypt
func UnwrapField(dek []byte, stored string) (string, error)
//  dispatch：e1:→Decrypt；p:→去前綴（並由 lazy 步轉換）；
//            無前綴→當 legacy DEK 密文 Decrypt（向後兼容 enc_* 欄）
```

`UnwrapField` 對 `p:` 值要**照樣返回明文**（遷移後、用戶未登入前都能讀），但呼叫者（storage）讀到 `p:` 時唔阻功能；轉換只靠 §5 lazy 步。

---

## 5. 兩段式遷移

### 5.1 Migration v1 → v2（啟動時，**唔需要任何密碼**）
`backend/internal/storage/migrate.go`（新檔），喺 `NewSQLiteStore` apply schema 之後跑：

1. `PRAGMA user_version` 讀出；≥2 → skip（冪等）。
2. 單一事務：逐表建 `*_v2` 新 schema → Go 迴圈讀舊行 → 計算 `owner_id`/`email_hash`/`name_hash`，內容欄包 `p:`（已是密文嘅 `enc_*`/`two_fa.secret`/`encrypted_private_key` 原樣搬）→ 寫入 → drop 舊表 + rename。
3. 任何一步錯 → ROLLBACK，DB 停留 v1，啟動 fail closed（唔會半遷移上線）。
4. `users` 新欄 `pending_encrypt INTEGER DEFAULT 0`；凡遷移過嘅 owner 設 1。
5. 舊表 rename 做 `*_v1_bak` 保留？→ **唔保留**（備份檔先於一切；DB 內留明文舊表係反目標）。回退 = 还原 §6 備份。
6. `user_version=2`。

碰撞規則（`Bob@x.com` vs `bob@x.com` → 同一 owner_id）：遷移以 normalize 後嘅 id 分組，保留 `created_at` 最新嗰行，其餘 row 合併丟棄 + log `WARNING [MIGRATE] merge <table> id=<...>`。 contacts UNIQUE 同理（email_hash 撞 → 保最新）。理論上舊程式已一路 normalize 寫入，碰撞應極少。

### 5.2 Lazy v2b：sentinel → DEK（用戶首次登入時）
- Hook 位置：`Login`（`maybeMigrateTwoFA` 旁）同 `Verify2FA→completeLogin`——DEK 到手嗰一瞬間。
- 動作：`if cred.Pending { EncryptPendingOwner(ownerID, dek) }`：單一事務，逐表將該 owner 所有 `p:` 值 `UnwrapField(明文) → WrapField(dek) → UPDATE`；完成 → `pending_encrypt=0`。
- 失敗：log ERROR，**唔阻登入**（`p:` 照讀得），下次登入再試（冪等）。
- 遷移後所有新寫入都經 `WrapField`，永遠唔會再有 `p:`（sentinel 係一次性存量債）。
- 密碼遺失／永久休眠嘅 owner：其行永遠停留 `p:`（可讀明文）→ 管理員用審計 query（§6 步驟 6）決定聯絡/處理。

---

### 5.3 Sentinel／Migration 程式碼生命週期（owner 決定：**存量清零後全部徹底移除**）

v0.6.0 帶住遷移程式碼上線 → 限期登入（§6 步驟 6）→ 審計確認 **`p:` 殘量 = 0 且 `pending_encrypt` 全清** → 後續 cleanup commit（M5）一次過刪走：

| 刪除項目 | 位置 |
|---|---|
| Migration 全套（建表改寫、`p:` 包裹、user_version guard、事務/回滾） | `migrate.go` + `NewSQLiteStore` 接線 + `migrate_test.go` |
| Lazy 轉換 hook（登入時 `p:`→DEK） | auth.go / completeLogin + 相關 test |
| `UnwrapField` 嘅 `p:` 分支 | `crypto/field.go` + test |

兩個代價（拍板前必讀）：
1. **Removal gate 係硬性 =0**：有殘留照刪 = 遲返嘅用戶數據變讀唔出亂碼（等同損毀）。殘留 → 只能寬限或聯絡用戶確認銷毀
2. **舊備份失效**：刪走 migration 後，`user_version<2` 備份冇「升級 image」拯救路徑；deadline 前備份只可用喺 v0.6.x 世界內 rollback

## 6. 部署順序（升級日）

1. `docker compose down`
2. **備份**（硬性前置）：`docker run --rm -v e2mail_data:/d -v $PWD:/b alpine tar czf /b/data-backup-$(date +%F).tgz /d`  
   注意：`DB_BACKUP` 自動快照寫喺 **同一個** data volume（`/data/backups/`），**唔算** 離機升級備份。詳見 [`BACKUP.md`](BACKUP.md)。
3. `docker compose up -d`（新 image：啟動自動 v2 migration）
4. Smoke：舊帳號登入 → mail/contacts/PGP/settings/sieve 全功能 → log 無 `[MIGRATE] ERROR`
5. 再登入一次確認 `pending_encrypt` 清 0
6. **限期登入公告（owner 決定，硬性政策）**：所有用戶必須喺 deadline（建議 2 週）前登入一次——成功登入即自動完成 §5.2 lazy 轉換。deadline 當日審計：

```sql
SELECT 'pending_users', COUNT(*) FROM users WHERE pending_encrypt = 1;
SELECT 'accounts',   COUNT(*) FROM accounts  WHERE label LIKE 'p:%' OR email LIKE 'p:%' OR username LIKE 'p:%' OR imap_host LIKE 'p:%' OR smtp_host LIKE 'p:%' OR sieve_host LIKE 'p:%' UNION ALL
SELECT 'contacts',   COUNT(*) FROM contacts  WHERE email LIKE 'p:%' OR display_name LIKE 'p:%' OR given_name LIKE 'p:%' OR family_name LIKE 'p:%' OR note LIKE 'p:%' OR source LIKE 'p:%' UNION ALL
SELECT 'contact_keys',COUNT(*) FROM contact_keys WHERE name LIKE 'p:%' OR fingerprint LIKE 'p:%' OR key_id LIKE 'p:%' OR armored_key LIKE 'p:%' UNION ALL
SELECT 'keyrings',   COUNT(*) FROM personal_keyrings WHERE public_key_armored LIKE 'p:%' OR fingerprint LIKE 'p:%' OR key_id LIKE 'p:%' UNION ALL
SELECT 'folder_prefs',COUNT(*) FROM folder_prefs WHERE folder_name LIKE 'p:%' UNION ALL
SELECT 'folder_order',COUNT(*) FROM folder_order  WHERE folder_name LIKE 'p:%' UNION ALL
SELECT 'user_prefs', COUNT(*) FROM user_prefs WHERE pref_value LIKE 'p:%';
```

7. 殘留 owner 逐個處理（三選一）：**寬限** ／ **接受殘餘風險**（該 owner 保持 `p:` 態）／ **聯絡用戶確認後銷毀其數據**。密碼已遺失者永不可能清零 → 要執行 §5.3 移除，必須先處理晒佢哋
8. 公告用戶：之後攞到 DB 檔＝淨係 hash+結構

回退：還原備份 + 跑舊 image。**注意 v2 DB 唔支援舊 binary 直接跑**（舊 code 唔識 owner_id 欄）。

---

## 7. 需要改嘅檔案清單

### 後端（新增）
| 檔 | 內容 |
|---|---|
| `backend/internal/crypto/field.go` | OwnerID / WrapField / UnwrapField / IsPendingField（§4） |
| `backend/internal/crypto/field_test.go` | 向量 + round-trip + `p:`/legacy 兼容 |
| `backend/internal/storage/migrate.go` | migration v2（§5.1）+ `EncryptPendingOwner`（§5.2）+ `CountPending()` 審計 |
| `backend/internal/storage/migrate_test.go` | v1 fixture（多 owner、大小寫碰撞、legacy enc 欄、各表齊嘅行）→ v2 → 斷言；冪等（跑兩次）；事務回滾（注入錯誤→DB 停留 v1）；lazy 轉換 round-trip |

### 後端（修改）
| 檔 | 改動 |
|---|---|
| `backend/internal/storage/sqlite.go` | `Store` interface 加 `dek []byte` 參數（只係內容函數；`DeleteAccount`/`CountAccounts`/`SetDefaultAccount` 等 opaque-key 函數唔加）；schema DDL 全部換 v2；scan/insert 經 Wrap/Unwrap；`ListAddressContacts` 改記憶體搜尋；`folder_order` 加 `owner_id`；`GetUserPref/SetUserPref` 值加解密；`users` 加 `pending_encrypt` |
| `backend/internal/api/handler/auth.go` | storage 內容 calls 傳 dek（`accountsWithPassword`、ChangePassword `ListAccounts/UpdateAccount`、2FA `SaveTwoFA`…）；`Login`/`completeLogin` 加 lazy hook；`normalizeEmail` 保留給 session 比較用 |
| `backend/internal/api/handler/auth2fa.go` | `GetTwoFA/SaveTwoFA/DeleteTwoFA` calls 維持 email 參數（內部 hash）；`decryptTwoFASecret` 改用 `crypto.UnwrapField` |
| `backend/internal/api/handler/accounts.go` | CRUD/list 傳 `authCtx.DEK`；`SetFolderPref/Order` 傳 DEK；`GetAccount` 結果明文（照返 JSON 給前端） |
| `backend/internal/api/handler/contacts.go`、`address_contacts.go` | 聯絡人兩張表 calls 傳 DEK；import 流程Bulk 傳 DEK |
| `backend/internal/api/handler/pgp.go` | keyring get/save 傳 DEK（公開欄加解密；private 既有雙重包不变） |
| `backend/internal/api/handler/prefs.go` | `GetUserPref/SetUserPref` 傳 DEK |
| `backend/internal/api/handler/mail.go`、`sieve.go`、`events.go` | **零改**（只用 session 明文 accounts） |
| `backend/internal/api/middleware/auth.go` | **零改**（passwords map 照 legacy raw b64 解） |
| `backend/cmd/server/main.go` | 無新 env；migration 於 `NewSQLiteStore` 內跑——啟動日誌加 `[MIGRATE] v2 applied rows=...` |
| `backend/internal/api/handler/auth_pwchange_test.go`、`auth2fa_test.go`、`storage 舊測` | 跟新簽名/欄位調整；加斷言：CreateAccount 之後直接讀 DB raw 必須係 `e1:`/密文而唔係明文 |
| `docs/LDAP.md`、`docs/MultiAccounts.md` | 補一句 owner_id 索引變化指針到本文 |

### 前端
**冇**。

---

## 8. 殘餘風險（明碼標價，全部已拍板接受）

| 風險 | 備註 |
|---|---|
| enum oracle：攞住 DB 可逐個 hash 驗證任何 email 是否用戶 | 裸 hash 決定嘅必然結果 |
| 結構 metadata：幾多帳號/contacts/folders、時間戳、端口、TLS、uuid | 等值查詢/COUNT 必然代價 |
| Lazy 視窗：owner 未再登入前，佢嘅內容欄係 `p:` 可讀明文 | 限期登入政策處理（§5.2/§6）；密碼遺失者永久 |
| 弱密碼 | `wrapped_dek` 離線暴破（Argon2id 成本）；UI 已警示 |
| Live server 沒收 | DEK 喺 RAM；session 用 server key 包 DEK——本設計只防 cold DB theft |
| 裝置 session（P1.15 / Phase 5） | `device_sessions.enc_dek` 用 **SESSION_SECRET** 包 DEK（同 RAM session），令重啟後 IDLE/push 可恢復。DB 賊要同時有 `SESSION_SECRET` 先解到。Token 等內容欄仍係用戶 DEK（`e1:`） |
| avatar 圖片檔 | 存於 `/data` 檔案系統，**本次範圍外**（DB 只存 uuid 檔名）；要加密另案 |
| IMAP/SMTP 實際郵件內容 | 從來唔入 DB（即時代理），與本設計無關 |

## 9. 驗收標準

1. `go test ./... -race` 全綠（含新 migrate/lazy/field 測試）
2. 手工 e2e：用舊版產生嘅真實 DB copy → 升級 → 登入 → 所有功能正常 → `sqlite3` 直駁 DB：任搜任何 email/聯絡人名/`grep -r "明文值" e2Mail.db*`（連 WAL 都查）**零命中**
3. 新 DB（fresh install）同樣全密文（除 §3.1）
4. 冪等：重複啟動 migration 無效；重複 lazy hook 無效

## 10. 里程碑

| # | 內容 | 估時 |
|---|---|---|
| M1 | crypto/field.go + storage v2 schema + migration（含碰撞）+ 測試 | ½–1 日 |
| M2 | handler DEK plumbing + 搜尋改記憶體 + 舊測更新 | 1 日 |
| M3 | lazy hook + pending 審計 + e2e（用真實舊 DB） | ½ 日 |
| M4 | 文檔收尾（本文轉 final、LDAP/MultiAccounts 交叉引用）+ tag v0.6.0 | ½ 日 |
| M5（deadline 後） | §5.3 徹底移除：migration、lazy hook、`p:` 讀取分支 + tests（前提：§6 步驟 6 審計 = 0） | ¼ 日 |
