# Sieve / ManageSieve 設計文件（e2mail）

> 分支：`sieve`（不影響 `main`）| 狀態：✅ 已實作完成（待你審閱/測試）| 後端 `go vet`/`go test`、`前端 build/test` 皆通過

> **運行提示：** 需確保 Dovecot Pigeonhole ManageSieve 已啟用並可從 e2mail 連達，本分支已支援 per-account `sieveHost/sievePort` 設定。

---

## 1. 背景與目標

仿 Roundcube `managesieve` 外掛，為每位郵件帳號提供 **Sieve 過濾器管理**：

*   每帳號獨立（沿用現有 multi-account 模型 `accounts` + `sessionID::accountID` 隔離）
*   兩種編輯模式可切換（同 Roundcube）：
    *   **① 規則模式（Rule Builder）**：表單式條件+動作，自動生成 Sieve
    *   **② 原始碼模式（Raw Editor）**：直接編輯 `.sieve` 腳本
*   後端對接 **Dovecot Pigeonhole ManageSieve (RFC 5804, 4190/tcp)**，已確認你方已開：
    ```
    protocols += sieve
    service managesieve { inet_listener sieve { port = 4190 } }
    sieve = file:~/sieve; active=~/.dovecot.sieve
    # Roundcube side 已設：$config['managesieve_default']='/etc/dovecot/sieve/global'
    ```
*   暫不做 Vacation 自動回覆捷徑（你已確認）

---

## 2. 非目標

*   不支援無 ManageSieve 的公共郵局（Gmail/Outlook 等）— 前端探測後顯示「此帳號不支援過濾器」而非報錯
*   不做伺服器端 Sieve 語言完整解析/AST，`CHECKSCRIPT` 交由 Dovecot 驗證
*   不修改 `main` 分支任何檔案；本分支審閱通過後再合併

---

## 3. 總體架構

```
Browser (React)  ──HTTP /api/sieve/*──▶  Go (chi)  ──TCP 4190 ManageSieve──▶ Dovecot Pigeonhole
      │                                    │
      │  per-account ?account= / X-Account  │  per-account SieveConfig{Host,Port,TLS,...}
      │  Rules JSON ↔ Sieve text            │  密碼複用 Account.EncIMAPPassword (DEK 解密)
      └────────────────────────────────────┘
```

*   **認證**：ManageSieve 與 IMAP 共用 `Username/Password`（多數部署同機同密碼），`SieveHost` 預設=`IMAPHost`，可每帳號覆蓋
*   **連線**：短連即關（sieve 操作低頻），不入 `imap.PoolManager` 池；超時 15s，TLS 邏輯照搬 `backend/internal/imap/client.go:69-101`
*   **多帳號**：`middleware.GetCurrentAccount()` 已支援 `?account` / `X-Account` 選帳號，Sieve 沿用

---

## 4. 後端設計

### 4.1 儲存層 `backend/internal/storage/sqlite.go`

**Account 擴充（4 欄，後向兼容舊 DB）：**

```go
type Account struct {
    // ... existing ...
    SieveHost             string `json:"sieveHost"`
    SievePort             int    `json:"sievePort"`              // 預設 4190，0 表示跟隨 IMAPHost
    SieveUseTLS           bool   `json:"sieveUseTls"`            // 預設 true
    SieveAllowInsecureTLS bool   `json:"sieveAllowInsecureTls"`
}
```

`schema` `accounts` 表加：

```sql
sieve_host TEXT NOT NULL DEFAULT '',
sieve_port INTEGER NOT NULL DEFAULT 0,
sieve_use_tls INTEGER NOT NULL DEFAULT 1,
sieve_allow_insecure_tls INTEGER NOT NULL DEFAULT 0
```

啟動時對舊庫做 `ALTER TABLE ADD COLUMN IF NOT EXISTS`（冪等遷移，`NewSQLiteStore` 內執行）。`scanAccount()`/`CreateAccount()`/`UpdateAccount()` 同步更新。

*替代方案*：若想零 DB 變更，可先「零欄」—永遠 `SieveHost=IMAPHost:4190`，但你已要求每帳號獨立，建議加欄。

### 4.2 配置 `backend/internal/config/config.go`

```go
type ServerConfig struct {
    // ... existing ...
    DefaultSieveHost         string
    DefaultSievePort         int
    DefaultSieveAllowInsecureTLS bool
}
```

`Load()` 讀環境：

```
DEFAULT_SIEVE_HOST   (預設 ""，空則跟 IMAPHost)
DEFAULT_SIEVE_PORT   (預設 4190)
DEFAULT_SIEVE_ALLOW_INSECURE_TLS (預設 false)
```

補 `.env.example`, `docker-compose.yml` 模板，`GET /api/server-config` 一併暴露給前端預填。

### 4.3 ManageSieve 客戶端 `backend/internal/sieve/client.go`（新建）

不引入外部依賴，手寫 `textproto` 狀態機（仿 `imap/client.go` TLS 分支）：

```go
package sieve

type Config struct {
    Host             string; Port int; UseTLS bool; AllowInsecureTLS bool
    Username, Password string
}
type ScriptInfo struct { Name string `json:"name"`; Active bool `json:"active"`; Size int `json:"size,omitempty"` }
type Client struct { conn net.Conn; reader *textproto.Reader; writer *textproto.Writer; caps map[string]string }

func Dial(ctx context.Context, cfg Config) (*Client, error) // TLS / Insecure / STARTTLS 分支，讀 banner
func (c *Client) Capability() (map[string]string, error)
func (c *Client) Authenticate() error // AUTHENTICATE "PLAIN" base64(\0user\0pass)
func (c *Client) ListScripts() ([]ScriptInfo, error) // LISTSCRIPTS
func (c *Client) GetScript(name string) (string, error) // GETSCRIPT
func (c *Client) PutScript(name, content string) error  // PUTSCRIPT + CHECKSCRIPT
func (c *Client) CheckScript(content string) (string, error) // CHECKSCRIPT
func (c *Client) SetActive(name string) error // SETACTIVE (空字串=停用全部)
func (c *Client) DeleteScript(name string) error // DELETESCRIPT
func (c *Client) HaveSpace(name string, size int) error // HAVESPACE
func (c *Client) Logout() error
```

流程：`Dial → CAPABILITY（Sieve extensions: fileinto, copy, reject...）→ AUTHENTICATE → 指令 → LOGOUT → Close`。每次 HTTP 請求建一條短連（15s timeout），錯誤回 502/503 並透出 Dovecot 原文。

**為何不入池**：sieve 頻率低（人手編輯），池化增加複雜度；短連足夠。

### 4.4 Handler `backend/internal/api/handler/sieve.go`（新建）

```go
type SieveHandler struct { storage storage.Store; cfg *config.ServerConfig }

func NewSieveHandler(store storage.Store, cfg *config.ServerConfig) *SieveHandler

// 內部 helper
func (h *SieveHandler) acquireSieveClient(ctx context.Context, r *http.Request) (*sieve.Client, *middleware.AuthContext, *storage.Account, func(), error)
```

**路由**（`backend/internal/api/router.go:52-139` 保護組 `protected` 內）：

```
GET    /api/sieve/capability              → Capability  (探測，非必需但方便前端)
GET    /api/sieve/scripts                 → ListScripts
GET    /api/sieve/scripts/{name}          → GetScript
PUT    /api/sieve/scripts/{name}          → PutScript  {content: string}
DELETE /api/sieve/scripts/{name}          → DeleteScript
POST   /api/sieve/scripts/{name}/activate → SetActive
POST   /api/sieve/check                   → CheckScript {content: string}
```

全部支援 `?account=ID` / `Header X-Account`，用 `middleware.GetCurrentAccount()` 取帳號，`GetCurrentAccountPassword()` 取密碼，`SieveHost` 為空則 `fallback=IMAPHost`，`SievePort==0` 則 `4190`。

**錯誤處理**：

*   連唔到 4190 → `502 sieve_unavailable` + `{"error":"無法連接 ManageSieve (host:4190): ..."}`
*   認證失敗 → `401`（與 IMAP 同密碼，提示檢查帳號密碼）
*   語法錯誤（CHECKSCRIPT/PUTSCRIPT 回 `NO`）→ `400` + Dovecot 原文
*   非 Dovecot 能力缺失（如 `fileinto` 需 `require "fileinto";`）→ 正常回 200，`CheckScript` 回 warnings

**Accounts 擴充** `backend/internal/api/handler/accounts.go:41-54`：

```go
type AccountRequest struct {
    // ... existing ...
    SieveHost string `json:"sieveHost"`
    SievePort int    `json:"sievePort"`
    SieveUseTLS bool `json:"sieveUseTls"`
    SieveAllowInsecureTLS bool `json:"sieveAllowInsecureTls"`
}
```

`CreateAccount`/`UpdateAccount` 寫入新欄；`TestAccount` 加 `sieveDialTest`（選做，若 SieveHost 未配則跳過）。

### 4.5 主程式 `backend/cmd/server/main.go`

```go
sieveHandler := handler.NewSieveHandler(store, serverConfig)
router := api.NewRouter(..., sieveHandler, ...)
```

### 4.6 其他後端檔案

*   `backend/pkg/response` 沿用 `response.Success/BadRequest/InternalServerError`
*   `docker-compose.yml` 加註解模板；`Dockerfile` 無需改
*   新增測試 `backend/internal/sieve/client_test.go`（mock `net.Conn` 測 LISTSCRIPTS 解析）、`handler/sieve_test.go`

---

## 5. 前端設計

### 5.1 新路由與狀態

`frontend/src/stores/useMailStore.ts:18 view` 擴為：

```ts
view: 'mail' | 'accounts' | 'contacts' | 'sieve'
```

`App.tsx:118-125` 增：

```tsx
{view === 'sieve' ? <SievePage /> : view === 'accounts' ? ...}
```

### 5.2 API 模組 `frontend/src/api/sieve.ts`（新建）

```ts
export interface SieveScriptInfo { name: string; active: boolean; size?: number }
export interface SieveCapability { implementation: string; sasl: string; sieve: string; starttls?: string; extensions?: string[] }

export const sieveApi = {
  capability(accountId?: string): Promise<SieveCapability>
  list(accountId?: string): Promise<SieveScriptInfo[]>
  get(name: string, accountId?: string): Promise<{name:string, content:string}>
  put(name: string, content: string, accountId?: string): Promise<void>
  remove(name: string, accountId?: string): Promise<void>
  activate(name: string, accountId?: string): Promise<void> // name="" → 停用全部
  check(content: string, accountId?: string): Promise<{ok:boolean, message?:string}>
}
```

內部沿用 `frontend/src/api/client.ts:12 request()`，自動帶 `Authorization: Bearer`，`accountId` 則拼 `?account=`。

### 5.3 組件 `frontend/src/components/sieve/`（新建目錄）

#### `SievePage.tsx`（外框，仿 `AccountsPage.tsx:236-344` / `ContactsPage.tsx`）

*   頂部 `Header` 類：返回 `mail` + 標題「過濾器 / Sieve」+ 帳號切換下拉（沿用 `useActiveAccount()`，每帳號獨立）
*   帳號無 sieve 能力（`capability` 探測失敗）→ 空狀態 `AlertTriangle` + 「此帳號未啟用 ManageSieve（4190），請聯繫管理員」
*   主體左右兩欄（`lg:grid-cols-[280px_1fr]`，行動端上下堆疊）：
    *   左：腳本列表（`ScriptList.tsx`）
    *   右：編輯區（依 `mode` 切換 `RuleBuilder.tsx` / `SieveEditor.tsx`）

#### `ScriptList.tsx`

顯示 `useQuery(['sieveScripts', accountId], () => sieveApi.list(accountId))`，每行：名稱 `.sieve` 去後綴顯示 + `Active` badge（藍）+ 大小 + 操作（設為活動/刪除）。選中行反白，加載 `Skeleton`。

#### `SieveEditor.tsx`（Raw 模式）

*   `textarea`（先不引入 CodeMirror 重依賴，後續可加 `codemirror` 後綴高亮）
*   工具列：`檢查語法`（→ `sieveApi.check`）→ 顯示 `OK`/`NO + 行號`；`儲存`（→ `PUT /scripts/{name}`）；`另存新檔`
*   保存後可選「同時設為活動」
*   `labelCls/inputCls` 沿用 `AccountsPage.tsx:36-38` Tailwind 樣式，保持視覺一致

#### `RuleBuilder.tsx` + `sieveGenerator.ts`（規則模式，Roundcube 式）

**數據模型** `frontend/src/types/sieve.ts`：

```ts
type Rule = {
  id: string
  name: string
  enabled: boolean
  conditions: { header: string; op: 'contains'|'is'|'matches'|'exists'; value: string; comparator?: string }[]
  conditionJoin: 'allof'|'anyof'  // 對應 Sieve allof/anyof
  actions: ({type:'fileinto', mailbox:string} | {type:'redirect', address:string} | {type:'reject', text:string} | {type:'discard'} | {type:'stop'} | {type:'keep'})[]
}
```

UI：仿 Roundcube 每條規則一卡片，含「若…則…」表單（header 下拉含 `Subject/From/To` 預設來自 `$config['managesieve_default_headers']` + 自定義）、集合關係（全部/任一）、動作列表（移至資料夾/轉寄/拒絕/捨棄/停止）。支援新增/刪除/拖曳排序、啟用開關。

**資料夾下拉**：`fileinto` 動作的信箱欄位用 `<datalist>`（`sieve-folder-options`）串接真實 IMAP 資料夾清單（`useQuery(['folders', accountId], mailApi.getFolders)`），可下拉選取亦可自填新名（逗號分隔多個）；`setflag` 等亦有 `\Seen`/`\Flagged` 常用旗標 datalist。

**雙向轉換**（`utils/sieveGenerator.ts`，token 化 + 遞迴下降解析器）：

*   `rulesToSieve(rules: Rule[]): string`：生成完整 `.sieve`（頭部 `require ["fileinto","imap4flags","copy","reject"]` 自動推斷，`if allof/anyof(...){ ... }`）。終止動作自動補 `stop;`（已有則不重複）。
*   `sieveToRules(sieve: string): Rule[] | null`：支援 **Roundcube / Dovecot 常見語法**——
    *   測試：`header` / `address`（含 `:domain` `:localpart` `:user` / `:all`）、`exists`、`true`，比較符 `:contains` `:is` `:matches`（`:comparator` 自動忽略）、`not`（限簡單測試）、`allof(...)` / `anyof(...)`、隱式 anyof（多值 string-list 展開）、標頭/信箱多值 list、同行或隔行大括號
    *   動作：`fileinto`（含 `:copy` 與多資料夾）、`redirect`、`reject`/`ereject`、`discard`、`keep`、`stop`、`setflag`/`addflag`/`removeflag`（imap4flags）
    *   註解 `# rule:[名稱]` 作為規則名（與 Roundcube 格式互通）
    *   不支援（`vacation`、`envelope`、`body`、`currentdate`、`variables`/`set`、`elsif`/`else`、巢狀 `if`、混層 group 語義不安全展開）→ 回傳 `null`，UI 自動提示「此腳本含進階語法，僅能在原始碼模式編輯」並切 Raw

**模式切換**：頂部 `SegmentedControl`（規則 / 原始碼），切換時彈 `ConfirmDialog` 若未儲存；規則→原始碼 實時生成預覽；原始碼→規則 嘗試解析。

#### `SieveAccountSettings.tsx`（AccountsPage 內摺疊區）

在 `frontend/src/components/accounts/AccountsPage.tsx:121-163` IMAP/SMTP 區塊後加：

```
▸ Sieve 進階設定（選填，留空=跟隨 IMAP 主機:4190）
  Host [        ]  Port [4190]  [✓] 使用 TLS  [ ] 允許自簽
```

`emptyForm`、`existing` 映射新欄，前端 `AccountInput` 擴充 `sieveHost/sievePort/sieveUseTls/sieveAllowInsecureTls`。

### 5.4 Sidebar `frontend/src/components/layout/Sidebar.tsx:546-552`

在「通訊錄」按鈕之上加：

```tsx
<button onClick={() => setView('sieve')} className="... bg-amber-50/...">
  <ListFilter className="w-4 h-4 text-amber-600" /><span>過濾器</span>
</button>
```

icon 用 `lucide-react: SlidersHorizontal` 或 `ListFilter`。

### 5.5 樣式與響應式

*   沿用 `AGENTS.md` 要求：`lg:`/`md:`/`sm:` 斷點，觸控 target ≥ 44px，不依賴 hover
*   編輯器行動端全寬 + 底部固定工具列
*   `Toast` 提示沿用 `frontend/src/stores/useToastStore.ts`

---

## 6. 安全與兼容

*   `SieveAllowInsecureTLS` 默認 false，僅自簽環境開啟；日誌不打印密碼
*   `PUTSCRIPT` 大小限制與 Dovecot `sieve_max_script_size` 對齊（後端不強限，交 Dovecot 返回）
*   多帳號隔離：`AuthContext.Passwords[accountID]` 按帳號取密碼，不跨帳號
*   舊庫遷移冪等；新欄 `DEFAULT ''/0` 不影響現有帳號

---

## 7. 實施步驟（審閱通過後，按此順序在 `sieve` 分支執行）

1.  `storage/sqlite.go` + `config/config.go` + `.env.example`/`docker-compose.yml`
2.  `internal/sieve/client.go`（含單元測試 mock）
3.  `handler/sieve.go` + `handler/accounts.go` 擴欄 + `router.go` + `cmd/server/main.go`
4.  `go vet` + `go test ./... -race`
5.  前端 `api/sieve.ts` + `types/sieve.ts` + `sieveGenerator.ts`
6.  `components/sieve/{SievePage,ScriptList,SieveEditor,RuleBuilder}.tsx`
7.  `Sidebar.tsx` / `App.tsx` / `AccountsPage.tsx` 整合
8.  `npm run build` + `npm run test` + 手動對接 Dovecot 4190 驗收

---

## 8. 驗證計劃

*   後端：`go test ./...`、`go vet`，新增 `sieve/client_test.go` 測 banner/能力/腳本列表解析
*   前端：`npm run test`（Vitest），測 `sieveGenerator` 規則↔原始碼往返
*   整合：`docker compose up -d --build` 後，用測試帳號對 `dovecot:4190` 執行 `LISTSCRIPTS → PUTSCRIPT test.sieve → SETACTIVE → GETSCRIPT → DELETESCRIPT` 全鏈路；行動端 375px 測編輯器可用性
*   負面：配 `imap.gmail.com:993` 帳號，前端應顯示「不支援 ManageSieve」而非 500

---

## 9. 開放問題（請你審閱時確認）

1.  `SieveHost` 默認跟隨 `IMAPHost` 是否接受？或需後台強制固定為 `Dovecot:4190`？
2.  規則模式生成的 `require` 行是否需暴露給用戶編輯，抑或自動推斷即可？
3.  是否允許同一帳號多腳本（Roundcube 默認多腳本+單 active）抑或簡化為單一 `managesieve.sieve`？
4.  刪除/設為活動 是否需 `ConfirmDialog` 二次確認（仿 `AccountsPage:332-341`）？

---

審閱通過後，回覆「可以開始」即在 `sieve` 分支開始實作；有任何需調整之處直接在 `SIEVE.md` 留言或回覆即可。
