# Multi-Accounts Support — 設計文檔

> 狀態：**已實作**（M1-M5）
> 目標：允許單一登入會話內同時管理多個 Email 帳號（類似 Thunderbird / Mail.app / Outlook 多帳號面板）

---

## 1. 背景與現狀

目前 e2mail 係「1 登入 = 1 帳號」模型：

- 登入時填 IMAP/SMTP host/port + 帳號 + 密碼 → 建立一個 `session.Session`。
- 密碼以 AES-GCM 加密存於 session 記憶體。
- IMAP/SMTP 連線由 `PoolManager` 按 session 管理。
- PGP keyring 係 **per-user**（SQLite `personal_keyrings`），同 email 綁定。

要支援多帳號，核心挑戰係把「session = 單一帳號」擴充成「session = 帳號集合」，並讓 IMAP/SMTP pool、SSE、keyring 都按帳號隔離。

> **設計方向（由零開始）：** 所有帳號（含首帳號）嘅 IMAP/SMTP 密碼一律以 DEK 加密存 DB（envelope encryption，見 §2），**唔再存 session 記憶體**。密碼由 DB 解密取得，作為 session 解鎖後使用。

---

## 2. 資料模型

### 後端 — 帳號 registry（新表）

於 SQLite 新增 `accounts` 表（per-user，關聯到登入使用者）：

```sql
CREATE TABLE accounts (
    id            TEXT PRIMARY KEY,          -- uuid
    user_email    TEXT NOT NULL,             -- 登入者（owner）
    label         TEXT NOT NULL,             -- 使用者自訂名稱（例如 "公司信箱"）
    email         TEXT NOT NULL,             -- 帳號 email 地址

    imap_host     TEXT NOT NULL,
    imap_port     INTEGER NOT NULL,
    imap_use_tls  INTEGER NOT NULL DEFAULT 1,
    imap_allow_insecure_tls INTEGER NOT NULL DEFAULT 0,

    smtp_host     TEXT NOT NULL,
    smtp_port     INTEGER NOT NULL,
    smtp_use_tls  INTEGER NOT NULL DEFAULT 1,
    smtp_allow_insecure_tls INTEGER NOT NULL DEFAULT 0,

    username      TEXT NOT NULL,             -- 認證使用者名稱（通常=email）
    -- 密碼以 DEK 加密存 DB（envelope encryption，見 §2）。唔落盤明文。
    imap_password TEXT NOT NULL,             -- AES-GCM_Encrypt(DEK, imap_password)
    smtp_password TEXT NOT NULL,             -- AES-GCM_Encrypt(DEK, smtp_password)

    is_default    INTEGER NOT NULL DEFAULT 0, -- 預設帳號（登入時自動選取）
    sort_order    INTEGER NOT NULL DEFAULT 0,

    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_accounts_user ON accounts(user_email);
```

### 登入密碼（Master Password）概念

> **呢個係成個 LUKS 設計嘅根基，必須先定清楚。**

現時系統係「1 登入 = 1 帳號」，**直接用該帳號嘅 IMAP 密碼登入**（`LoginRequest.Password` → 驗證 IMAP → 存入 session）。**根本冇獨立嘅「登入密碼」**。

多帳號後要支援所有帳號密碼加密存 DB 嘅 envelope encryption，**由零開始、唔理向後相容**，採用最簡單直接嘅方案：

> **Master Password = 第一個（登入嗰個）帳號嘅 IMAP 密碼。**

- Master Password 即係首帳號嘅 IMAP 密碼，唔需要另設新密碼。
- 佢一方面用嚟驗證首帳號 IMAP 連線（現有邏輯），另一方面派生 MasterKey 去解鎖 DB 內所有帳號嘅加密密碼。

#### 流程

1. **首次登入**（第一帳號）：填 IMAP/SMTP 密碼登入並驗證 IMAP 後，**以該 IMAP 密碼作為 Master Password**。
2. **派生**：`MasterKey = Argon2id(IMAP 密碼, per-user salt)`。
3. **儲存**：隨機生成 **DEK** → `wrapped_dek = AES-GCM_Encrypt(MasterKey, DEK)` → 每個帳號（包括首帳號）嘅 IMAP/SMTP 密碼用 DEK 加密存 DB。
4. **之後登入**：輸入首帳號 IMAP 密碼 → unwrap DEK → 解鎖所有帳號密碼。登入流程**照樣要驗證 IMAP**（現有邏輯）以防密碼錯。
5. **改首帳號 IMAP 密碼**：MasterKey 由新 IMAP 密碼重新派生 → 只需 `wrapped_dek = Encrypt(Argon2id(新密碼), 同一 DEK)`，所有其他帳號密碼原封不動（LUKS 式）。同時要更新 DB 內首帳號本身嘅加密密碼。

> 注意：首帳號同時兼任 Master Password 角色，所以佢嘅 IMAP 密碼**唔可以刪除 / 唔可以變成只有 SMTP**；預設（default）帳號亦應固定為首帳號（或限制首帳號不可刪除）。

### Session 模型擴充

- `session.Session` 保持「登入使用者」概念（`user_email` + 用於解鎖 credentials 嘅 Master Password，即首帳號 IMAP 密碼）。
- 新增 `Accounts []AccountSummary`（帳號設定，**不含密碼**）。
- 新增 `MasterKey []byte` 或 `DEK []byte`（解鎖後嘅 key，**只存記憶體，唔序列化**，`json:"-"`）——見下「Session/Context 密碼 map」。

### 密碼儲存 — LUKS 式 envelope encryption（所有帳號強制加密存 DB）

**所有帳號（包括首帳號）嘅 IMAP/SMTP 密碼一律以 DEK 加密存 DB**，Master Password（首帳號 IMAP 密碼）只 wrap 個 DEK。改 Master Password 只需 re-wrap DEK，**唔使重加密任何其他帳號密碼**（即 LUKS「改 passphrase 唔使重加密成個硬碟」）。

```
MasterKey = KDF(首帳號 IMAP 密碼)           ← 由 Master Password 派生（Argon2id，每 user 獨立 salt）
DEK       = 隨機生成嘅 one-account-key      ← 用嚟 encrypt 所有帳號密碼

DB 儲存：
  wrapped_dek = AES-GCM_Encrypt(MasterKey, DEK)
  每帳號       = AES-GCM_Encrypt(DEK, imap_password)
                AES-GCM_Encrypt(DEK, smtp_password)
```

- **首次登入**：以首帳號 IMAP 密碼作 Master Password → 派生 MasterKey → 隨機生成 DEK → 加密存 `wrapped_dek` + 首帳號（及往後所有）帳號密碼。登入驗證照樣連 IMAP 確認（現有邏輯）。
- **之後登入**：輸入首帳號 IMAP 密碼 → unwrap `wrapped_dek` → 成功 = 解鎖晒所有帳號密碼。登入照樣連 IMAP 驗證。
- **改 Master Password（即改首帳號 IMAP 密碼）**：只需 `wrapped_dek = Encrypt(KDF(新密碼), 同一 DEK)`，並更新 DB 內首帳號本身嘅加密密碼；其他帳號密碼原封不動。
- **安全**：攻擊者攞到 DB 冇首帳號 IMAP 密碼就 decrypt 唔到 DEK → 讀唔到任何密碼；DEK 隨機生成，可獨立 rotate。每帳號密碼用 DEK 加密時可再分開 nonce/salt。

### Session/Context 側嘅密碼 map 設計（唔淨係 DB 側）

現時 `MemoryStore` 只有單一 `EncryptedPassword`，`middleware.Auth` 喺**每個請求**都 `GetDecryptedPassword(sess)` 攞一個密碼放入 context，handler 直接攞嚟用。多帳號後要擴充成 **per-account**：

#### 記憶體側（`MemoryStore` / `Session`）

```go
// Session 新增（只存記憶體，json:"-"）
type Session struct {
    // ... 現有欄位 ...
    Accounts []AccountSummary `json:"accounts"`
    DEK      []byte           `json:"-"` // unwrap 後嘅 DEK，用嚟解密 DB 內每個帳號密碼
}
```

- **所有帳號**：密碼一律加密存 DB（用 DEK）。`Session` 只保留 `DEK`；帳號密碼由 DEK 即時解密（或登入時一次過解出存 map）。
- `MemoryStore` 要支援**以 accountID 為單位**新增/更新/移除密碼，唔再係單一值。

#### Context 側（`middleware.Auth`）

- `Auth` 中間件要解析 `?account=<id>`（或 header `X-Account`），揀出該帳號嘅「解密密碼」，放入 context。
- Context value 由單一 `PasswordContextKey` 改為 **`map[string]string`（accountID → 密碼）**，或**拆做兩層**：
  - `AccountsContextKey`：`[]AccountSummary`（含每個帳號連線設定，供 handler 建立 client）。
  - `PasswordsContextKey`：`map[string]string`（accountID → 明文密碼）。
- 新增 helper：`middleware.GetAccountFromContext(ctx, accountID)` ／ `GetPasswordForAccount(ctx, accountID)`，缺省 account 時返回 default 帳號（§6）。
- 所有現有 handler（`mail.go`、`events.go`、`auth.go`）改用 helper 攞「該帳號嘅 client」，唔再直接攞單一 password。

### IMAP/SMTP pool 鍵

- `PoolManager` 現按 `sess.ID`（session uuid）管理連線。多帳號後一個 session 有多個帳號，**改為按 `(sessionID, accountID)` 做 key**（唔係 `(user_email, accountID)`——同一 user_email 可以有多個並行 session），令每個 session 內每個帳號有獨立連線池。
- `IdleManager`（SSE）同樣按 `(sessionID, accountID)` 訂閱。
- 帳號刪除/編輯時，需相應 `DestroyPool(sessionID, accountID)`。

---

## 3. API 設計

新增 `/api/accounts` 群組（全部需登入驗證）：

| Method | Path                     | 用途                                   |
|--------|--------------------------|----------------------------------------|
| GET    | `/api/accounts`          | 列出帳號（含 label/email/isDefault）     |
| POST   | `/api/accounts`          | 新增帳號（含密碼、IMAP/SMTP 設定）       |
| PUT    | `/api/accounts/{id}`     | 編輯帳號（label/伺服器設定；密碼可留空=不變）|
| DELETE | `/api/accounts/{id}`     | 刪除帳號（不可刪除最後一個 / 預設帳號）    |
| POST   | `/api/accounts/test`     | 測試 IMAP/SMTP 連線（body 傳連線參數；新增/編輯時即時驗證）|
| POST   | `/api/accounts/{id}/test`| 測試已存帳號嘅連線（沿用 DB 密碼，可覆寫）          |
| POST   | `/api/accounts/{id}/default` | 設為預設帳號                         |
| GET    | `/api/accounts/{id}/folders` | 指定帳號資料夾清單                    |

> **測試連線 contract 修正**：新增帳號**未有 id**，所以測試唔可以只靠 path `{id}`。採用 `POST /api/accounts/test`（body 帶完整連線設定 + 明文密碼），新增/編輯表單都 work；已存帳號則可用 `POST /api/accounts/{id}/test` 直接沿用 DB 密碼。兩者都分別回傳 IMAP / SMTP 結果。

> 現有 `/api/mail/*`、`/api/events` 需要加 `?account=<id>` 參數（或 header `X-Account`），未指定時用 `is_default` 帳號。SSE 多帳號架構見 §8。

### SSE 多帳號架構（具體化）

folder tree 要求**同時監聽所有帳號**先可以即時顯示每個帳號嘅 unread count。方案：

- **單一 SSE 連線 multiplex 所有帳號**（recommend）：
  - 前端維持**一條** `/api/events` SSE 連線（唔使每帳號開一條）。
  - 後端 `EventsHandler.SSE` 收到連線後，讀取 session 所有帳號，為**每個帳號** `GetOrStartListener(sessionID, accountID)`。
  - 每個 listener 嘅事件經 `AccountID` 欄位標記，SSE 統一推送；前端按 `accountId` 分發到對應帳號嘅 store。
  - 帳號動態增刪時，SSE 透過已存在嘅事件機制（或 session 重建 listener）增減訂閱。
- **`MailboxEvent` 擴充**：加 `AccountID string` 欄位，`NEW_MESSAGE` 事件時同時帶 `accountId`，前端先知道邊個帳號嘅 unread 要更新。
- **`IdleManager`**：key 由 `sess.ID` 改為 `(sessionID, accountID)`（§2 pool 鍵）；`GetOrStartListener` 按 `(sessionID, accountID)` 取得或建立。登出時 `StopListener` 要掃晒該 session 所有帳號嘅 listener。
- **連線數控制**：每個帳號一條 IDLE 連線，帳號 × 使用者線性增長 → 設**每個 session 帳號上限**（例如 5 個）+ **伺服器總 IDLE 連線上限**，超限時對額外帳號改用 polling fallback（見 §8）。

---

## 4. 前端 UI 設計

### 4.1 整體佈局（Thunderbird / iPhone Mail 式：folders 平鋪）

沿用現有 Header + Sidebar 結構，但 sidebar 改為**一棵 folder tree，所有帳號一次過平鋪**（同 Thunderbird / iOS Mail 一致），每個 folder 顯示自己的 unread count，所以可以一眼睇晒每個帳號有咩 folders 同有幾多未讀：

```
┌────────────────────────────────────────────────────────────┐
│ Header: [Logo]  [🔍搜尋]        [管理帳號] [PGP] [寫信] [登出]│
├──────────┬─────────────────────────────────────────────────┤
│ Sidebar  │                                                  │
│ ▾ 公司信箱         3   ← 帳號節點（顯示該帳號總未讀）        │
│    ▸ 收件匣       3                                          │
│    ▸ 已發送       0                                          │
│    ▸ 草稿箱       0                                          │
│ ▾ 私人信箱        12  ← 另一帳號，一齊顯示                   │
│    ▸ 收件匣       12                                         │
│    ▸ 封存         0                                          │
│ 資料夾…                                                      │
└──────────┬─────────────────────────────────────────────────┘
           ▼
   Message List / Viewer（顯示目前點擊嗰個 folder 嘅郵件）
```

- **Sidebar 係一棵 folder tree**：頂層係每個帳號（可摺疊），下面係該帳號嘅 folders。每個節點顯示 unread badge。
- **帳號節點顯示該帳號嘅總未讀數**（將所有 folder unread 加總），所以就算未展開該帳號都知道佢有冇新 email。
- **點擊任何 folder** → Message List 載入嗰個 (account, folder) 嘅郵件；Viewer 顯示揀中郵件。
- **Header**：由「帳號切換器」改為「管理帳號」入口（因為切換已經喺 sidebar 嘅 folder tree 完成）。Search/Composer 操作於**目前 active 帳號**（最後點擊嗰個）。
- 需要**同時監聽所有帳號**（每個帳號開一條 IMAP IDLE / SSE），先可以即時更新所有帳號嘅 unread count（見 §8）。

### 4.2 帳號管理頁面（`/accounts` 或 Modal）

採用 **全頁面 / 大型 Modal**（比 inline 適合，欄位多）：

```
帳號管理
┌────────────────────────────────────────────────┐
│ 帳號清單                                        │
│ ┌────────────────────────────────────────────┐ │
│ │ 👤 公司信箱   john@work.com    [設為預設][✏][🗑]│ │
│ │ 👤 私人信箱   me@gmail.com      [設為預設][✏][🗑]│ │
│ └────────────────────────────────────────────┘ │
│ [+ 新增帳號]                                    │
└────────────────────────────────────────────────┘
```

點「新增」或「編輯」→ 開啟**單一帳號配置表單**（Modal / 側邊 drawer）：

```
新增帳號 / 編輯帳號
┌─────────────────────────────────────────────────────┐
│ 帳號名稱 (label)   [ 公司信箱                     ]  │
│ Email              [ john@work.com                ]  │
│                                                    │
│ ── IMAP 伺服器 ──                                   │
│ Host      [ mail.work.com            ]  Port [993]  │
│ 加密       (•) TLS ( ) STARTTLS ( ) 無              │
│ ☐ 允許自簽憑證 (Allow insecure TLS)                  │
│                                                    │
│ ── SMTP 伺服器 ──                                   │
│ Host      [ mail.work.com            ]  Port [587]  │
│ 加密       (•) TLS ( ) STARTTLS ( ) 無              │
│ ☐ 允許自簽憑證                                      │
│                                                    │
│ 使用者名稱   [ john@work.com         ]              │
│ 密碼         [ •••••••••••••          ]（編輯時可留空=不變）│
│                                                    │
│ [ 測試連線 ]  ✅ IMAP 連線成功 / SMTP 連線成功         │
│                                        [儲存] [取消] │
└─────────────────────────────────────────────────────┘
```

**表單細節：**
- **「測試連線」按鈕**：儲存前即時呼叫 `/api/accounts/{id}/test`（新增時用暫存 id），分別顯示 IMAP / SMTP 結果。
- **加密欄位**：TLS / STARTTLS / 無 三選一（對應現有 login 表單邏輯，465=implicit TLS、587=STARTTLS、25=無/STARTTLS）。
- **密碼**：新增必填；編輯可留空（表示沿用舊密碼）。**所有帳號密碼一律以 DEK 加密存 DB**（§2）。
- **Master Password**：即首帳號嘅 IMAP 密碼（§2），用嚟解鎖所有帳號密碼。UI 於首次登入時要**醒目警告**「遺失首帳號 IMAP 密碼將永久無法解鎖所有帳號」。
- **「設為預設」**：登入後第一個載入嘅帳號。預設帳號唔可以刪除（或刪除前要先改預設）。
- **驗證**：Email 格式、Host 必填、Port 範圍。刪除前 confirm（避免誤刪）。

### 4.3 Mobile 體驗

- Sidebar（抽屜）內維持 folder tree：帳號節點 + 底下 folders，帳號節點可摺疊（touch target ≥ 44px）。
- 帳號多時，預設摺疊非 active 帳號，只展開目前帳號，避免 sidebar 過長。
- 帳號管理：用 **全螢幕 page**（scroll 長表單較好用），保留返回鍵。
- 唔用 hover-only；所有摺疊/選取/管理入口 tap 直達。

---

## 5. PGP Keyring 決策

現時 keyring 係 per-user。多帳號後採用：**per-user keyring 不變（選項 A）**——所有帳號共用同一 keyring。簡單、唔郁現有儲存；如果使用者多帳號但係同一人用同一把 key，啱用。

---

## 6. 遷移與向後相容

> **由零開始、唔理向後相容**（見 §2 決定）。

- **首帳號**：登入時以首帳號 IMAP 密碼作 Master Password，建立 `wrapped_dek` + 首帳號密碼加密存 DB，並設為 `is_default=1`。
- 之後新增帳號：一律以 DEK 加密存 DB。
- `/api/mail/*` 冇帶 account 時，後端 fallback 到 `is_default` 帳號。
- 密碼儲存為 `wrapped_dek`（DB）+ 每帳號密文（DB）；context 缺省 account 時返回 default。

---

## 7. 建議實作順序（里程碑）

| 里程碑 | 內容 |
|--------|------|
| **M1 後端帳號 CRUD** | `accounts` 表（含加密密碼欄）+ migration + `/api/accounts` CRUD + envelope encryption（DEK/wrapped_dek）+ session 密碼 map + pool 按 `(sessionID, accountID)` 分 key |
| **M2 後端 account 參數化** | `/api/mail/*`、`/api/events` 支援 account 參數 + default fallback + `test` 連線 + **SSE 多帳號 multiplex + `MailboxEvent.AccountID`** |
| **M3 前端 folder tree** | Sidebar 改為多帳號 folder tree（帳號節點 + folders + unread badge、可摺疊）、點 folder 載入該 (account, folder) |
| **M4 前端帳號管理 UI** | 帳號清單 + 新增/編輯表單 + 測試連線 + 設為預設 + 刪除（mobile + desktop） |
| **M5 測試與部署** | 後端 Go tests + 前端 Vitest、響 debian.exe.xyz 驗證 |

---

## 8. 風險與注意事項

- **所有帳號密碼加密存 DB**：採用 LUKS 式 envelope encryption（§2），首帳號 IMAP 密碼（Master Password）做 MasterKey wrap 個 random DEK。**不另設 recovery code**——若用戶遺失首帳號 IMAP 密碼，DB 內所有帳號密碼將永久無法解鎖。UI 必須醒目警告呢一點（尤其首次登入時）。
- **首帳號兼任 Master Password**：首帳號 IMAP 密碼同時係解鎖 key。需限制首帳號不可刪除／不可改為只有 SMTP，否則成個 keyring 失效（§2）。
- **Master Password 概念**：Master Password 即首帳號 IMAP 密碼，唔係獨立新密碼。改首帳號 IMAP 密碼＝改 Master Password，需 re-wrap DEK 並更新首帳號自身密碼（§2）。
- **SSE / IDLE 多帳號**：採單一 SSE 連線 multiplex 所有帳號（§3），每個帳號一條 IMAP IDLE 連線。要評估 server 連線數上限（帳號多 + 使用者多時連線數線性增長）→ 設每個 session 帳號上限（如 5 個）+ 伺服器總 IDLE 上限，超限對額外帳號改用 polling fallback（60 秒，沿用 idle.go 現有 fallback）。
- **刪除帳號**：唔刪 keyring（per-user keyring 屬 user，與帳號無關）。確認 UI 要清楚提示。
- **效能**：點 folder 先 SELECT + fetch（延遲載入）；unread count 靠背景監聽更新；可用現有 cache（staleTime）減少重複 fetch。
