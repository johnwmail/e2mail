# Multi-Accounts Support — 設計文檔

> 狀態：**設計/計劃**（未開始實作）
> 目標：允許單一登入會話內同時管理多個 Email 帳號（類似 Thunderbird / Mail.app / Outlook 多帳號面板）

---

## 1. 背景與現狀

目前 e2mail 係「1 登入 = 1 帳號」模型：

- 登入時填 IMAP/SMTP host/port + 帳號 + 密碼 → 建立一個 `session.Session`。
- 密碼以 AES-GCM 加密存於 session 記憶體（`SESSION_SECRET`）。
- IMAP/SMTP 連線由 `PoolManager` 按 session 管理。
- PGP keyring 係 **per-user**（SQLite `personal_keyrings`），同 email 綁定。

要支援多帳號，核心挑戰係把「session = 單一帳號」擴充成「session = 帳號集合」，並讓 IMAP/SMTP pool、SSE、keyring 都按帳號隔離。

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
    -- 密碼**不落盤**。只存於 session 記憶體（AES-GCM 加密），同現有機制一致。

    is_default    INTEGER NOT NULL DEFAULT 0, -- 預設帳號（登入時自動選取）
    sort_order    INTEGER NOT NULL DEFAULT 0,

    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_accounts_user ON accounts(user_email);
```

### Session 模型擴充

- `session.Session` 保持「登入使用者」概念（user_email + 密碼用於解鎖 credentials）。
- 新增 `Accounts []AccountSummary`（帳號設定，**不含密碼**）。
- 密碼儲存：現有單一 `Password` → 改為 `map[accountID][]byte`（AES-GCM 加密，key = 現有 `SESSION_SECRET`）。密碼喺「新增/編輯帳號」時由前端傳入並加密保存於 session 記憶體。

### IMAP/SMTP pool 鍵

- `PoolManager` 現按 session 管理連線 → 改為按 `(user_email, accountID)` 做 key，令每個帳號有獨立連線池。
- `IdleManager`（SSE）同樣按 `(user_email, accountID)` 訂閱。

---

## 3. API 設計

新增 `/api/accounts` 群組（全部需登入驗證）：

| Method | Path                     | 用途                                   |
|--------|--------------------------|----------------------------------------|
| GET    | `/api/accounts`          | 列出帳號（含 label/email/isDefault）     |
| POST   | `/api/accounts`          | 新增帳號（含密碼、IMAP/SMTP 設定）       |
| PUT    | `/api/accounts/{id}`     | 編輯帳號（label/伺服器設定；密碼可留空=不變）|
| DELETE | `/api/accounts/{id}`     | 刪除帳號（不可刪除最後一個 / 預設帳號）    |
| POST   | `/api/accounts/{id}/test`| 測試 IMAP/SMTP 連線（新增/編輯時即時驗證）|
| POST   | `/api/accounts/{id}/default` | 設為預設帳號                         |
| GET    | `/api/accounts/{id}/folders` | 指定帳號資料夾清單                    |

> 現有 `/api/mail/*`、`/api/events` 需要加 `?account=<id>` 參數（或 header `X-Account`），未指定時用 `is_default` 帳號。

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
- **密碼**：新增必填；編輯可留空（表示沿用舊密碼）。
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

- 現有使用者登入時自動建立第一個 `accounts` row（`is_default=1`），label 預設 = email，credential 由現有 session 沿用 → **現有單一帳號體驗不變**。
- `/api/mail/*` 冇帶 account 時，後端 fallback 到 `is_default` 帳號 → **舊前端/舊請求仍 work**（平滑過渡）。
- Session 密碼儲存由單一值遷移到 map，向後相容：現有單一 `Password` 視作 default 帳號密碼。

---

## 7. 建議實作順序（里程碑）

| 里程碑 | 內容 |
|--------|------|
| **M1 後端帳號 CRUD** | `accounts` 表 + migration + `/api/accounts` CRUD + session 密碼 map + pool 按帳號分 key |
| **M2 後端 account 參數化** | `/api/mail/*`、`/api/events` 支援 account 參數 + default fallback + `test` 連線 |
| **M3 前端 folder tree** | Sidebar 改為多帳號 folder tree（帳號節點 + folders + unread badge、可摺疊）、點 folder 載入該 (account, folder) |
| **M4 前端帳號管理 UI** | 帳號清單 + 新增/編輯表單 + 測試連線 + 設為預設 + 刪除（mobile + desktop） |
| **M5 測試與部署** | 後端 Go tests + 前端 Vitest、響 debian.exe.xyz 驗證 |

---

## 8. 風險與注意事項

- **密碼只在記憶體**：重啟後需重新輸入（除非日後加「記住密碼」加密落盤——目前**唔建議**，保持安全）。
- **SSE / IDLE 多帳號**：folder tree 要求**同時監聽所有帳號**先可以即時顯示每個帳號嘅 unread count，每個帳號要開一條 IMAP IDLE 連線 → 要評估 server 連線數上限（帳號多 + 使用者多時連線數會線性增長，可能要設上限或改用 polling fallback）。
- **刪除帳號**：唔刪 keyring（per-user keyring 屬 user，與帳號無關）。確認 UI 要清楚提示。
- **效能**：點 folder 先 SELECT + fetch（延遲載入）；unread count 靠背景監聽更新；可用現有 cache（staleTime）減少重複 fetch。
