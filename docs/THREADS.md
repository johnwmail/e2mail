# Threads 對話串模式 — 設計文檔

> 狀態：**已實作**（T1–T4 + 單封隱箭咀 + DB 持久化）
> 決定：展開子項 **Gmail 式（最新喺頂）**、**默認收起**、**Sent 照 thread**、頂欄 **Mail/Threads 即時切換按鈕**（localStorage + **`user_prefs` DB** 雙重持久化）、**單封（messageCount≤1）唔顯示展開箭咀**
> 目標：為郵件清單提供 Gmail / Roundcube 式「對話串（thread）」分組顯示，把同一來往（References / In-Reply-To / 主題）的郵件摺疊成一組
> 資料庫：`sqlite3` 只加 `user_prefs`（key-value，存 thread 模式狀態）；thread 分組本身係 IMAP header 的即時運算結果，無新表

---

## 1. 背景與現狀

### 現有基礎（已核實）

| 項目 | 位置 | 狀態 |
|------|------|------|
| 每封已有 `MessageID` | `internal/imap/client.go:485`（envelope fetch） | ✅ 已隨 `MessageSummary` 回傳 |
| 髮信已帶 `inReplyTo` / `references` | `frontend Composer` → `POST /mail/send` → SMTP 寫入 header | ✅ 自己發出嘅回覆可正確鏈接 |
| 清單分頁 | `FetchMessageSummaries(page, limit, query)` `client.go:351` | ⚠️ 以「單封」為單位，thread 模式要改以「conversation」為單位 |
| IMAP `THREAD` 命令（RFC 5256） | 無 | ❌ 唔依賴 — Gmail 先支援，其他 server 多數冇，**改用客戶端 JWZ 演算法**（同 Roundcube/Thunderbird 對齊） |

### 痛點

- 565 封 inbox 中大量重複主題（`apt-listchanges`、Cron、來往回覆），flat 清單難睇
- 一封回覆同佢嘅原信喺清單入面分唔晒組

---

## 2. 演算法 — JWZ 式線程分組（後端 Go）

### 2.1 資料來源

對資料夾內所有 UID 做一次 pipeline fetch（兩樣嘢，皆係 header 級別，唔碰 body）：

1. `ENVELOPE`（已有）→ `Message-ID`、`Subject`、`Date`、`From`
2. `BODY.PEEK[HEADER.FIELDS (REFERENCES IN-REPLY-TO)]` → 引用鏈

### 2.2 分組規則（JWZ，參考 `mailto:johnjb@jwz.org` 經典實作）

```
1. 每個 UID 建 node{ id, refs[], parent }
2. 由 references 末尾開始搵：第一个「同組內已有、且無循環」嘅 message-id 做 parent
   （循環偵測：若 parent 鏈已包含自己 → 斷鏈做 root）
3. 無 references 嘅 message：用正規化 subject fallback：
   subjKey = lower(trim(replace subject 嘅 "Re:"/"Fwd:"/"答复:"/"轉寄:"/前綴、[tag])) 
   → 同 subjKey 且無 parent 者掛到該組 root（僅限 subject 唔係空/唔係 "no subject"）
4. 每個连通分量 = 1 thread；threadId = root node 嘅 message-id（冇就 "subj:"+subjKey 合成）
5. 排序：thread 以組內「最新 date」排（降序）；**組內子項以 date 降序（Gmail 式：最新喺頂，原信喺底）**
```

### 2.3 快取與增量（關鍵設計：唔好每次 list 都掃全 folder）

- 索引結構 `threadIndex`：`map[accountID+folder]` 存於包級 `sync.Map`，欄位：
  `uid→node`、`threadId→[]uid`、`threadId→{subject, newestDate, senders, unreadCount, hasAttachment, msgCount}`、`lastUIDNEXT/lastUIDVALIDITY`、`builtAt`
- **失效條件**（任一即重建或增量）：
  - `SELECT` 回傳嘅 `UIDNEXT/UIDVALIDITY` 變咗（新信/遷移）→ **增量**：只 fetch `UID lastSeen+1:*` 嘅 header，append 入 index；`UIDVALIDITY` 變咗先至全量重建
  - SSE `EXPUNGE` / `FLAG_UPDATE` / `MOVE` 事件 → 標記 dirty，下次 list 前增量刷新（FLAG 類只更新計數，唔重組鏈）
  - TTL 60 秒兜底 + 現有「重新整理」按鈕強制重建
- **規模上限**：每 folder 索引最多 20,000 封（超過即 thread 模式降級為 flat 並回 header 提示）；帳號登出 / 連線銷毀即回收
- 首次建索引成本參考：565 封 ≈ 2 次 pipeline header fetch，正常連線 < 2s，僅發生一次

---

## 3. API 設計

### 3.1 清單（擴充現有端點，向後相容）

```
GET /api/mail/messages?folder=INBOX&page=1&limit=50&q=&thread=0|1
```

- `thread` 缺省 `0` → **完全不變**（現行 flat 行為）
- `thread=1` → 回傳 `ThreadListResult`：

```json
{
  "folder": "INBOX",
  "mode": "threads",
  "total": 120,            // thread 總數（唔係單封數）
  "page": 1, "limit": 50, "totalPages": 3,
  "threads": [
    {
      "threadId": "<uuid@mail>",
      "subject": "部署問題討論",
      "date": "2026-08-31T09:30:00Z",     // 組內最新
      "senders": ["johnw@…", "root"],      // 去重、按出現排
      "messageCount": 4,
      "unreadCount": 2,
      "hasAttachment": true,
      "starred": false,
      "messages": [ MessageSummary…, 最多 20 封，含 uid/flags/date/from/snippet ]
    }
  ]
}
```

- 搜尋 `q` 照舊喺 backend filter 後先分組（只喺 match 集內組鏈）
- 單封 detail / raw / attachments / flags / move / delete **全部不動**（前端已有各 UID 嘅 operation，thread 只係清單層）

### 3.2 實作位置

- `internal/imap/thread.go`（新）：`BuildThreadIndex`、`RefreshThreadIndex`、`JWZ 分組`、`subjectKey`
- `internal/imap/client.go`：新函數 `FetchThreadList(ctx, folder, page, limit, query)` 讀 index → 分頁輸出
- `internal/imap/parser.go`：`MessageSummary` 加 `References []string`（flat 模式唔回傳，omitempty）
- `internal/api/handler/mail.go`：`ListMessages` 讀 `?thread=1` 分流；`MessageListResult` 加 `Mode` 欄位
- `internal/imap/idle.go`：現有 SSE 事件已夠（`NEW_MESSAGE/EXPUNGE/FLAG_UPDATE` 帶 accountId），backend 標記 dirty 即可

---

## 4. 前端 UI 設計

### 4.1 模式切換（對齊你 Roundcube 截圖）

- `MessageList` 頂欄加 `Mail / Threads` 兩個圖示按鈕（`Inbox` / `MessagesSquare` lucide icon），喺「共 N 封」右邊
- **點擊即時生效**：切換即改 `listMode` 並即時以新 queryKey refetch（`enabled` 掛 `listMode`，**唔使手动刷新/重載頁**），按鈕以 `bg-blue-600 text-white` 高亮當前模式
- 狀態入 `useMailStore.listMode: 'messages' | 'threads'`，持久化 `localStorage('e2Mail_list_mode')` **+ 後端 `user_prefs` 表（`/api/prefs/listMode`）**：本地寫入即時生效，後台異步 sync DB；登入後自 DB 載入覆蓋本地快取 → 跨裝置一致；切換時重置 `page=1`
- **摺疊默認全收起**（已確認決定 2）；展開後組內子項 **Gmail 式最新喺頂**（決定 1）；`Sent` 照樣 thread（決定 3）
- 每個 folder 共用同一模式（唔做 per-folder 設定，MVP）

### 4.2 thread 行渲染

```
┌──────────────────────────────────────────────┐
│ [☐] ★ ▾ [頭像×2] 部署問題討論  +4    09:30 ● │   ← thread 根行（最新嗰封嘅 snippet）
│        ├ 原信…   johnw   08:00               │   ← 展開後：子項縮排（+16px/層，最高 4 層）
│        │   └ 回覆… root  08:30 ●             │      ●=未讀點、附件 clip icon 保留
│        └ 最新回覆… johnw 09:30 ●             │
└──────────────────────────────────────────────┘
```

- **摺疊行為**：默認收起（只顯示根行：`senders` 前 2 + `+N`、subject、messageCount badge、最新 date、unread 點）；點 ▾/▸ chevron 展開成組內按日期降序（Gmail 式，最新喺頂）嘅子行；子行點擊照舊開 `ViewerPane`（用該 UID）；**單封（`messageCount ≤ 1`）唔顯示 chevron**（無嘢可展開）
- **根行本身 = 展開後嘅「最新一封」**：chevron 直接 tap 展開/收起；要睇最新內文就照舊 tap 行體開 viewer
- **未讀樣式**：thread 有未讀 → 整行加粗 + 藍點；展開後逐封維持現有單封未讀樣式
- **全選**：`select all` 喺 thread 模式 = 選中當頁所有 thread（實際選中佢哋全部 member UID）
- **多選**：tap 根行 checkbox = 成組選中（member UIDs 全入 `selectedUIDs`）；現有 flags/move/delete mutation 全部照用（本身就係 UID 陣列 API，**零後端改動**）
- **左滑操作（mobile swipe）**：保留喺根行（刪除/已讀/垃圾郵件成組執行）
- **版本顯示「共 N 封」**：thread 模式改顯示 `共 N 個對話`（用 API `total`）

### 4.3 分頁與資料流

- `useQuery(['messages','threads', accountId, folder, page, limit, q])`，與 flat 模式分開 queryKey，避免緩存互污
- `thread=1` 時 `MessageList` map `threads[]`；`messages` 數組前端直接渲染摺疊，**唔使逐組再 fetch**
- 展開/收起狀態用 component-level `Set<threadId>`（唔入 store，刷新後收起係合理預設）

### 4.4 Mobile 體驗（`AGENTS.md` 要求）

- chevron tap target ≥ 44px（`p-2.5`），縮排每層 16px、超過 4 層統一折返
- 子行日期/發件人喺 `375px` 下用現有 `truncate` 模式；展開行加 `bg-slate-50` 微底色方便追鏈
- 唔依賴 hover；`hover:` 全部有對應觸控狀態

---

## 5. 邊界與決策

| 情境 | 處理 |
|------|------|
| 跨 folder 嘅 thread（回覆移咗去 Archive） | **唔跨** — index per folder，各 folder 各組各嘅（Gmail 標籤式跨文件夾超出範圍） |
| 無 Message-ID 嘅古舊郵件 | 只靠 subject fallback；都冇就自成一組 |
| `Re: Re: Re:` 循環引用 / 斷鏈 | JWZ 循環偵測斷鏈；斷鏈者另起 thread（同 Thunderbird 行為一致） |
| Sent folder | 照樣 thread（用戶來往往住喺 Sent+INBOX 兩邊；Sent 內自己嘅回覆鏈照組） |
| 大 folder（>20k 封） | 降級 flat + 提示「對話串过多，請歸檔」（防記憶體） |
| IMAP server 唔支援某 FETCH 語法 | header.FIELDS 係 RFC 3501 核心功能，通用；失敗則該次 list 降級 flat + console warn |
| 效能紅線 | 建索引**唔准碰 body**；全部 fetch 只 ENVELOPE + 指定 header fields |
| SSE 新信（IDLE） | index 標 dirty → 下次 list 增量 append（只 fetch 新 UID），badge/清單自動帶埋新信入組 |

---

## 6. 不做事項（明確 scope out）

- ❌ thread 級「全部標已讀」新後端端點（前端 map member UIDs 用現有 API 已夠）
- ❌ Gmail 式標籤化 thread 合并（跨 folder）
- ❌ DB 持久化 thread index（記憶體 + 增量已夠；server 重啟重建一次即得）
- ❌ 後端 IMAP `THREAD` 命令（兼容性差，JWZ 取代）

---

## 7. 建議實作順序（里程碑）

| 里程碑 | 內容 | 驗收 |
|--------|------|------|
| **T1 後端索引** | `thread.go` JWZ 分組 + header 增量 fetch + `threadIndex` 快取/dirty/TTL + `FetchThreadList` + `?thread=1` 分流 + Go 測試（含循環/斷鏈/subject fallback/跨頁用例） | `go test ./... -race` 過；`curl '...messages?thread=1'` 回 thread 結構 |
| **T2 前端清單** | 模式切換按鈕 + store/localStorage + `threads` query + 摺疊渲染 + 「共 N 個對話」 | 手機/桌面兩模式可切換，展開收起正確 |
| **T3 批量操作** | thread checkbox 成組選中、全選、左滑、flags/move/delete 用 member UIDs | 刪一個 thread = 成組消失，unread badge 同步 |
| **T4 打磨** | 搜尋+thread 互動、SSE dirty 增量、大 folder 降級提示、`Playwright`/手動 `375px` 回歸 | 新信 3 秒內入組；565 封首次建索引 < 2s，之後 list < 300ms |

---

## 8. 風險與注意事項

- **首次建索引延遲**：只影響「第一次開 thread 模式」，之後增量；UI 加 skeleton（「正在建立對話串…」）避免誤以爲卡死
- **記憶體**：node/索引欄位精简（uid、parentId、date、flags），5k 封 ≈ 每 folder 幾 MB 級；LRU 上限 50 folder × 帳號
- **並發**：index 讀寫用 per-key mutex；SSE dirty 標記只置 flag，唔併發重建
- **向後相容**：`thread` 參數缺省 0，現有 flat 客戶端/測試零影響
- **私隱**：全程 header 運算，唔涉及 PGP 內文，雲端唔會多知任何嘢
