# Contacts 通訊錄 — 設計文檔

> 狀態：**草案（Draft）**，未實作
> 目標：為每位登入使用者提供獨立通訊錄，支援一鍵將郵件寄件人加入聯絡人、CSV/vCard 匯入/匯出，寄件人若已在通訊錄則自動顯示頭像/名稱
> 資料庫：**保留 `sqlite3`（`modernc.org/sqlite`）**，不遷移至 Postgres/MariaDB（原因見 §8）

---

## 1. 背景與現狀

現時 `backend/internal/storage/sqlite.go` 已有 `contact_keys` 表，但**只存 PGP 公鑰**（`owner_email + contact_email → armored_key / fingerprint`），用途係加密而非通訊錄。

使用者痛點：
- 睇信時無法一鍵收藏寄件人
- 無集中通訊錄，寫信時要手打地址
- 無頭像，寄件人辨識度低

本設計**保留 `contact_keys` 不變**，新增通用 `contacts` 表作通訊錄。兩表關係：通訊錄係「人」，`contact_keys` 係「人嘅 PGP 鑰匙」——可透過 `contact_email` 關聯，但獨立演進。

---

## 2. 資料模型（SQLite）

### 2.1 新表 `contacts`

```sql
CREATE TABLE IF NOT EXISTS contacts (
    id            TEXT PRIMARY KEY,          -- uuid
    owner_email   TEXT NOT NULL,             -- 擁有者（登入者 email）
    email         TEXT NOT NULL,             -- 聯絡人 email（lowercase 存）
    display_name  TEXT NOT NULL DEFAULT '',
    given_name    TEXT NOT NULL DEFAULT '',
    family_name   TEXT NOT NULL DEFAULT '',
    avatar_path   TEXT NOT NULL DEFAULT '',  -- 相對 /data/avatars/<owner>/<id>.bin，空=無頭像
    note          TEXT NOT NULL DEFAULT '',
    source        TEXT NOT NULL DEFAULT 'manual', -- manual | import_csv | import_vcard | auto_add
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    UNIQUE(owner_email, email)
);
CREATE INDEX IF NOT EXISTS idx_contacts_owner ON contacts(owner_email);
CREATE INDEX IF NOT EXISTS idx_contacts_email ON contacts(email);
CREATE INDEX IF NOT EXISTS idx_contacts_owner_email ON contacts(owner_email, email);
```

欄位說明：
- `email` 以 `strings.ToLower(strings.TrimSpace(...))` 正規化後存，查詢亦 lower 比對
- `avatar_path` **不存 BLOB**，只存檔路徑，避免 DB 膨脹；檔案實體 `dataDir/avatars/<sha1(owner_email)>/<contact_id>.<ext>`，由後端讀寫並控權限 `0700`
- `source` 用於匯入時去重提示與「自動加入」追蹤

### 2.2 與 `contact_keys` 關係

```
contacts (通訊錄)  1 ── 0..1  contact_keys (PGP)
  owner_email + email  ──►  owner_email + contact_email
```

查詢寄件人顯示時：先查 `contacts` 取 `display_name/avatar_path`，再可選查 `contact_keys` 知是否可 PGP 加密（顯示 🔒）。

### 2.3 匯入暫存（可選，不建表）

匯入時在記憶體做 dedup + validation，批量寫入時用 transaction；失敗回報 `skipped: [{email, reason}]`，不需持久暫存表。

---

## 3. 後端 API 設計

全部需登入（`middleware.Auth`），以 `owner_email = session.Email` 鑑權，**不暴露他人的聯絡人**。

| Method | Path | 用途 |
|--------|------|------|
| GET | `/api/contacts` | 列出通訊錄（支援 `?q=keyword` 搜尋 email/name，`?limit=&offset=` 分頁） |
| POST | `/api/contacts` | 新增單一聯絡人 `{email, displayName, note}` |
| PUT | `/api/contacts/{id}` | 更新聯絡人 |
| DELETE | `/api/contacts/{id}` | 刪除聯絡人 |
| POST | `/api/contacts/from-message` | 一鍵由郵件加入：`{accountId, folder, uid}` → 後端解析 `From` header 自動填入 |
| POST | `/api/contacts/import` | 匯入 `multipart/form-data`：`file` (csv/vcf) + `mode=skip|overwrite` |
| GET | `/api/contacts/export?format=csv|vcf` | 匯出 |
| GET | `/api/contacts/{id}/avatar` | 取得頭像（`Content-Type: image/*`，無則 404，前端 fallback 首字母） |
| PUT | `/api/contacts/{id}/avatar` | 上傳/更新頭像（`multipart`, 限 2MB, 僅 jpg/png/webp） |
| DELETE | `/api/contacts/{id}/avatar` | 移除頭像 |
| GET | `/api/contacts/resolve?emails=a@b.com,c@d.com` | 批量解析寄件人是否在通訊錄（供 `MessageList`/`ViewerPane` 批量取頭像/名稱，減少 N+1） |

### 3.1 匯入格式

- **CSV**：表頭 `email,display_name,given_name,family_name,note`（大小寫不敏感，至少 `email` 必填）。用 `encoding/csv`，寬鬆容錯。
- **vCard (.vcf)**：支援 vCard 3.0/4.0，解析 `FN`, `N`, `EMAIL`, `NOTE`, `PHOTO`（`PHOTO` 若為內嵌 base64 則寫入 `avatars`）。可用 `github.com/emersion/go-vcard`。
- 去重：`UNIQUE(owner_email, email)` → `mode=skip` 時略過已存在並回報 `skipped`，`overwrite` 時更新 `display_name/note`（不覆蓋已有頭像除非匯入有新圖）。

### 3.2 驗證與限制

- `email` 必符合 `net/mail.ParseAddress`，否則 400 並列入 `skipped`
- 每使用者上限：預設 2000 筆（防濫用，可 config 調整）
- 頭像：後端驗 `Content-Type` + 魔術字節，轉存時統一 resize 至 256x256（`golang.org/x/image` 或 `disintegration/imaging` 可選，MVP 可先原圖存）
- `resolve` 最大 100 emails / 請求

---

## 4. 前端 UI 設計

### 4.1 通訊錄頁面

- 入口：`Sidebar` 新增「聯絡人」項（`Users` icon），`Header` 亦可放快捷入口
- 佈局：沿用 `MessageList` 列表樣式，支援搜尋、字母索引、響應式（手機抽屜）
- 列表項：頭像（圓形，`contacts/{id}/avatar` 成功則 `<img>`，失敗顯示首字母色塊）+ 顯示名稱 + email + PGP 🔒（若 `contact_keys` 存在）
- 詳情 Drawer/Modal：編輯名稱、備註、上傳頭像、刪除、查看 PGP 指紋

### 4.2 一鍵加入寄件人

- `ViewerPane` 郵件頭部 `From` 旁顯示：
  - 若不在通訊錄：按鈕「＋ 加入聯絡人」
  - 若已在：顯示聯絡人名稱 + 頭像，hover 顯示卡片
- 點擊「加入」→ `POST /api/contacts/from-message` → toast 成功並即時 `invalidateQueries(['contacts'])`
- `MessageList` 每封信的寄件人亦做 `resolve` 批量查詢，自動顯示頭像（無需逐封加入）

### 4.3 匯入/匯出

- 通訊錄頁頂部按鈕：「匯入」→ 彈 `Upload`（拖拉支援）+ `mode` 選擇 + 預覽前 5 筆 → 確認 → 顯示 `saved/skipped` 結果
- 「匯出」→ 下拉選 `CSV` / `vCard`，直接下載
- 錯誤處理：`skipped` 列表可展開看 `reason`（格式錯、重複、超限）

### 4.4 寫信自動完成

- `Composer` 的 `To/Cc/Bcc` 輸入框：輸入時 `GET /api/contacts?q=` 即時建議（debounce 200ms），顯示頭像 + 名稱 + email，最多 8 項

### 4.5 Mobile 體驗

- 所有按鈕 tap target ≥ 44px，不依賴 hover
- 頭像與名稱在窄螢幕自動縮疊
- 匯入用原生 file picker，支援相機選圖作頭像

---

## 5. 頭像策略

1. **優先級**：聯絡人自訂頭像（`contacts.avatar_path`）＞ Gravatar（可選，預設關閉以保私隱）＞ 首字母色塊（`getInitials` + hash 背景色）
2. **儲存**：`PUT /avatar` 寫入 `dataDir/avatars/<owner_hash>/<contact_id>.webp`（統一後綴，轉碼可後加），DB 只存相對路徑
3. **讀取**：`GET /contacts/{id}/avatar` 需鑑權（檢查 `owner_email`），設 `Cache-Control: private, max-age=86400` + `ETag`
4. **私隱**：預設不向外發請求（不自動抓 Gravatar），僅顯示本地頭像或首字母

---

## 6. 遷移與相容

- 純新增表與檔案目錄，無破壞性變更
- 首次啟動 `NewSQLiteStore` 執行 `CREATE TABLE IF NOT EXISTS contacts`（寫入 `schema` 常量，`backend/internal/storage/sqlite.go:126`）
- 舊有 `contact_keys` 保持不動；可選提供一次性「由 `contact_keys` 生成通訊錄」腳本（將已有 PGP 聯絡人 `email/name` 匯入 `contacts`，`source=auto_add`，不覆蓋已存在者）
- 備份：`contacts` 與 `avatars/` 均在 `/data` volume 內，隨 `data` volume 持久化

---

## 7. 實作里程碑

| 里程碑 | 內容 | 驗收 |
|--------|------|------|
| **C1 後端 CRUD + 頭像** | `contacts` 表 + `Store` 介面 + `List/Get/Upsert/Delete` + `avatar` 讀寫 + 單元測試 | `go test ./...` 過，`curl /api/contacts` CRUD 正常 |
| **C2 一鍵加入 + 批量解析** | `POST /from-message`（解析 `From`）+ `GET /resolve?emails=` + `ViewerPane`「加入」按鈕 + `MessageList` 頭像顯示 | 手機/桌面寄件人自動顯示頭像，未在通訊錄可一鍵加入 |
| **C3 匯入/匯出** | `POST /import` (CSV/vCard) + `GET /export` + 前端匯入 Modal + 去重/錯誤回報 | 上傳 100 筆 CSV/vcf，`saved/skipped` 正確，匯出可再匯入 |
| **C4 寫信自動完成 + 通訊錄頁** | 獨立 `/contacts` 頁 + 搜尋/編輯/刪除 + Composer 自動完成 | 端到端：建聯絡人 → 寫信輸入即提示 → 發送 |
| **C5 打磨** | 頭像 resize、Gravatar 選項、每 user 上限、分頁、無障礙 | Vitest + Playwright 覆蓋關鍵路徑 |

---

## 8. 為何保留 SQLite 而非轉 RDS

- **自託管定位**：e2mail 為單節點 `docker-compose.yml` 單 service + `data` volume 設計（`AGENTS.md`），SQLite 零運維、備份即抄 `/data`，最吻合
- **規模匹配**：通訊錄每 user 數百至數千筆，讀多寫少，SQLite WAL 已足夠；`Store` 層已用 `sync.Mutex` + `SetMaxOpenConns(1)` 序列化寫入，無併發問題
- **成本**：轉 Postgres/MariaDB 需新增 `db` service、密碼/連線池/健康檢查、重寫 `storage` 與 `Dockerfile`，為通訊錄此量級不值
- **可移植**：本設計 SQL 保持 portable（僅 `TEXT/INTEGER/BLOB` + `UNIQUE` + `INDEX`），將來若真需橫向擴容，換 `postgres` driver + `golang-migrate` 即可遷移（`Store` 介面已抽象）

> **決策：維持 `modernc.org/sqlite`，不引入 RDS。**

---

## 9. 風險與注意事項

- **PII**：`contacts` 含使用者社交關係，必須 per-owner 隔離，API 嚴格校驗 `owner_email`
- **匯入安全**：CSV/vcf 可能含惡意字串（公式注入 `=cmd|`），匯出時對 `=` 開頭欄位加前置 `'`；頭像嚴格驗 MIME 與大小
- **效能**：`resolve` 需批量查避免 N+1；`contacts` 表 `owner_email` 索引已覆蓋；頭像走檔案系統不進 DB
- **與 `contact_keys` 一致性**：刪除通訊錄不自動刪 PGP 公鑰（避免誤刪加密能力），UI 提示「此聯絡人仍有 PGP 公鑰」
