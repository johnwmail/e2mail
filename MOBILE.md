# e2Mail Mobile (React Native / Expo)

Plan, design notes, and the full task board for a native iOS + Android client
that talks to the existing Go backend. Companion to [`README.md`](README.md) and
[`docs/`](docs/).

> **Status: Phase 6 settings parity is in tree.** Accounts, contacts, PGP, Sieve,
> appearance, 2FA, and LDAP password change are reachable from the native
> settings hub. Registering push still needs a **development build** on a
> physical device. Phase 3 on-device smoke (`P3.3`/`P3.7`) is still awaiting that
> build. `frontend/` is still **not** an npm workspace (`P2.1`). See the
> [task board](#task-board).

Task-board legend: `[x]` done · `[~]` in progress · `[ ]` todo. IDs (`P4.7`) are
stable references for commits and PRs — use them in commit messages, e.g.
`feat(mobile): message detail WebView (P4.7)`.

## Why React Native

Reuse TypeScript that is actually portable, then render **native UI** (not a
`WKWebView` shell of the SPA):

- REST DTOs and API modules (`frontend/src/types`, `frontend/src/api` except
  browser glue in `client.ts` / `sse.ts`),
- **OpenPGP.js** in `frontend/src/api/pgp.ts` (passphrases never leave the
  device; PGP decrypt-then-MIME rebuild lives here too),
- i18n catalogs + `t()`, sieve generator/parser.

Thread grouping and MIME body parsing are **backend** work (`?thread=1`,
`ParsedMessage`). Do not treat them as frontend code to migrate.

React Native lets us share that TS via `@e2mail/shared` instead of rewriting
crypto in Swift/Kotlin.

## Architecture

```text
┌───────────────────────┐        ┌───────────────────────┐
│  mobile/ (Expo RN)    │        │  frontend/ (React web) │
│  iOS + Android        │        │  Vite + Tailwind       │
│  native UI            │        │  DOM UI                │
└──────────┬────────────┘        └───────────┬───────────┘
           │            ┌──────────────────┐            │
           └───────────▶│  shared/ (TS)    │◀───────────┘
                        │  api · types     │
                        │  pgp · i18n      │
                        │  platform adapter│
                        └────────┬─────────┘
                                 │
                    ┌────────────▼─────────────┐
                    │  backend/ (Go, /api/*)   │
                    │  IMAP/SMTP proxy, SSE,   │
                    │  SQLite, PGP keyring     │
                    └──────────────────────────┘
```

`shared/` is platform-agnostic: it never imports `window`, `document`, or
`localStorage` directly. Browser- and device-specific behaviour is injected via
a small `Platform` object.

REST paths in this file omit the `/api` prefix unless the distinction matters
(SSE is `GET /api/events`).

## Repository layout

```text
e2mail/
├── backend/          Go server (unchanged)
├── frontend/         React web (Vite; own lockfile until P2.1)
├── shared/           @e2mail/shared — platform-agnostic TS
│   └── src/
│       ├── platform.ts       Platform interface + memory store + joinUrl
│       ├── api/              HTTP client + auth/2fa/mail/… factories
│       ├── types/            REST + sieve DTOs
│       ├── i18n/             catalogs + t() (no React)
│       ├── sieve/            rulesToSieve / sieveToRules
│       ├── pgp/              OpenPGP.js service + benchmark (subpath export)
│       ├── mail/             local-search helpers
│       └── index.ts          public entry (pgp is `@e2mail/shared/pgp`)
├── mobile/           Expo app (@e2mail/mobile)
│   ├── index.ts              entry: crypto polyfill → expo-router/entry
│   ├── app/                  expo-router routes (`_layout`, login, (app))
│   ├── app.json              scheme e2mail, splash, plugins
│   ├── eas.json
│   ├── metro.config.js       watchFolders + nodeModulesPaths
│   └── src/                  platform, crypto, stores, theme, i18n
├── package.json      npm workspaces root (shared + mobile)
├── package-lock.json
└── MOBILE.md         this file
```

`frontend/` is **not** part of the workspace yet. Web resolves `@e2mail/shared`
with Vite/TS path aliases onto `shared/src`. Adding it to workspaces (`P2.1`)
is a separate, revertible PR and does **not** block Phase 3–4.

## Why a repo folder, not a branch

A native app is a long-lived artifact. A branch would force constant rebases,
make API-contract changes span two lines of history, and break release tagging.
Keep mobile on `main` in `mobile/`; open short feature branches off it. (This
`mobile` branch is temporary — merge it to `main` once the scaffold is reviewed.)

A separate repo would only be worth it if mobile had different ownership or a
different licence. It would also wreck the main advantage (direct TS import) by
forcing an npm package / submodule sync.

## shared/ design

### Platform adapter

`shared/src/platform.ts` defines what each host must provide:

```ts
interface Platform {
  apiBaseUrl: string;              // e.g. https://mail.example.com
  fetch: typeof fetch;
  storage: KeyValueStore;          // session token: SecureStore on device
  language?: string;               // navigator.language | expo-localization
  onUnauthorized?(): void;         // clear token + redirect to login
  translate?(key: string, vars?): string;
}
```

`createHttpClient(platform)` reproduces the browser client's behaviour
(`Bearer` token, JSON `StandardResponse` envelope, 401 handling) without
touching globals. The web client supplies `createBrowserPlatform` (`P2.8`).

Phase 0 points **all** `storage` at `expo-secure-store`. Theme / locale /
list-mode must **not** live in Keychain (`P1.14`): token in SecureStore,
non-secrets in AsyncStorage (or equivalent).

`X-Account` is not sent yet. The HTTP client should pick an account with
either `X-Account` or `?account=` (web uses the query param). Native `fetch`
usually has no `Origin`, so CORS does not apply; Expo Web / a browser origin
must not send `X-Account` until
`backend/internal/api/middleware/cors.go` lists it in `AllowedHeaders`
(today: `Authorization`, `X-Session-ID`, not `X-Account`). Prefer `?account=`
until that additive CORS change lands, or always use the query on every host.

### What moves to shared/ (Phase 2)

| From `frontend/src`        | To `shared/src`        | Task  | Notes                                  |
|----------------------------|------------------------|-------|----------------------------------------|
| `types/api.ts`, `types/sieve.ts` | `types/`         | P2.2  | Web re-exports types from shared       |
| `i18n/` + locales          | `i18n/`                | P2.3  | Locale via storage + `language`        |
| `utils/sieveGenerator.ts`  | `sieve/`               | P2.4  | Pure functions                         |
| `api/*.ts` except glue     | `api/`                 | P2.5  | Injected `ApiClient`; see stay-in-app  |
| `api/pgp.ts`               | `pgp/`                 | P2.6  | Subpath `@e2mail/shared/pgp`; RN crypto in Phase 3 |

Optional extract (not blocking): local snippet search helpers in
`components/layout/MessageList.tsx` → `shared/src/mail/` (`P2.11`).

### What stays in the app layer

UI, navigation, Zustand stores, `window`/`document` glue, Vite `import.meta`,
mail HTML rendering (web: DOMPurify + sandboxed iframe; mobile: WebView
**component** for the body only), file/clipboard/share APIs, and SSE
**transport**. Keep `frontend/src/api/client.ts` and `sse.ts` as host adapters;
share `MailboxEvent` (already in `types/api.ts`) and JSON parse logic if useful.

Do not call `POST /mail/folders/subscribe` — the handler exists but is **not
registered** on the router (404).

## Mobile app design

- **Expo (managed)** + TypeScript. Navigation: **`expo-router`** (file-based
  routes in `mobile/app/`). Chosen over a hand-wired React Navigation tree:
  deep links (`P5.6`), typed routes, and Expo's documented monorepo setup come
  for free. React Navigation remains the engine underneath.
- **State**: reuse the same shape as the web (`zustand` + `@tanstack/react-query`
  both support React Native).
- **Token storage**: `expo-secure-store` (Keychain / Keystore). Never
  `AsyncStorage` for the session token.
- **API auth**: `Authorization: Bearer <token>`
  (`backend/internal/api/middleware/auth.go` extracts Bearer first, then
  `X-Session-ID`, then HttpOnly cookie `e2Mail_session`). Account:
  `?account=` or `X-Account` (`resolveAccountID`); default account if omitted.
  Web fetch uses Bearer + `?account=`; Web SSE uses the cookie (EventSource
  cannot set `Authorization`).
- **Events (foreground)**: `GET /api/events`. RN EventSource cannot send
  Bearer. Use `react-native-sse` (or a fetch stream) with
  **`X-Session-ID: <token>`**. Do **not** put the token in the query string
  (backend removed `?token=` on purpose). Background: APNs/FCM (Phase 5) — iOS
  will not keep the socket alive.
- **IDLE reality**: listeners watch **INBOX only** and emit **`NEW_MESSAGE`**
  only. `FLAG_UPDATE` / `EXPUNGE` appear on the TS union and the web
  invalidates on them, but the server barely emits them. After flags/move/
  delete, invalidate queries locally; do not wait for SSE.

### Session lifetime (P1.15)

API Bearer sessions remain 24h sliding TTL (`SESSION_TTL_HOURS`). Registering a
push token also persists a **device session** (`device_sessions`: session id +
`SESSION_SECRET`-wrapped DEK) so IMAP IDLE and APNs/FCM via Expo can resume
after a backend restart. Set a stable `SESSION_SECRET` in `.env` or the
container environment; without it, push only lasts for the current process.

### PGP on React Native

`openpgp` (OpenPGP.js v6) reads `globalThis.crypto` at import time and throws
when the WebCrypto API is missing. Decision (**P3.1**): use
**`react-native-quick-crypto`** (OpenSSL via Nitro/JSI) for `crypto.subtle` +
`crypto.getRandomValues`; it is the maintained, fastest option and does not
require writing a pure-JS WebCrypto shim. `@noble/*` was the alternative, but
OpenPGP.js already bundles noble primitives for its fallback paths, so the only
gap quick-crypto fills is `subtle`/random.

Implementation:

- `mobile/index.ts` is a custom entry that imports
  `mobile/src/crypto/polyfills` **before** `expo-router/entry`, so
  `install()` runs before any module pulls in OpenPGP.js.
- `mobile/src/crypto/polyfills.ts` calls `install()` (sets `global.crypto` and
  `global.Buffer`) and adds a `TextEncoder` built on the native `Buffer`. Expo's
  winter runtime provides `TextDecoder` but **not** `TextEncoder`; OpenPGP needs
  both.
- `mobile/src/crypto/polyfills.web.ts` overrides it on web, where WebCrypto and
  `TextEncoder` already exist, keeping quick-crypto out of the web bundle that
  `mobile.yml` exports.
- `react-native-get-random-values` is **not** needed: quick-crypto's native
  `getRandomValues` is what gets installed.
- `mobile/src/crypto/pgp.ts` wires `createPgpService()` (keyring + contact-key
  endpoints) to a client bound to the device `Platform`.

**Build implication:** quick-crypto is a native module, so PGP features require
a **development build / prebuild** (`eas build --profile development`), not
Expo Go. Login/session still work in Expo Go; only the crypto paths need the dev
client. `expo export --platform web` keeps working.

Keep the private-key passphrase in memory only, optionally cached in
`expo-secure-store` behind a biometric gate (`P3.6`,
`mobile/src/crypto/passphrase.ts` + `PassphrasePrompt`). The backend must keep
seeing only passphrase-encrypted blobs — it wraps those blobs with the session
DEK; it does not run OpenPGP on mail.

**Baseline timing (P3.7, Node 24, warm):** keygen ≈ 17 ms, encrypt ≈ 6 ms,
decrypt ≈ 3.5 ms, sign ≈ 1 ms, verify ≈ 0.3 ms for a 1 KB body. Device runs
(`shared/src/pgp/benchmark.ts`) should stay well under ~250 ms/op; above that,
show a blocking spinner and consider the noble fallback.

**P4.11 (send encrypt/sign) depends on Phase 3 acceptance.** Do not stub
client-side crypto.

### Push notifications

Requires backend work (there is no APNs path today) — Phase 5:

1. `mobile/` registers for push and uploads the device token.
2. New endpoint(s): store device tokens per user/account, e.g.
   `POST /api/push/devices`, `DELETE /api/push/devices/{token}`.
3. Backend sends APNs/FCM on new mail (hook into the existing IMAP IDLE
   `events` path — remember IDLE is INBOX/`NEW_MESSAGE` only). Credentials
   via GitHub secrets / env, never committed.
4. Deep-link the notification to the message (`/messages/{uid}`).

### Backend changes required (all additive)

| Change | Where |
|--------|-------|
| (P1.15) Durable device session if chosen | `backend/internal/api/handler/auth.go`, session store |
| (if using `X-Account` from a browser origin) allow header | `backend/internal/api/middleware/cors.go` |
| Device-token table + endpoints | `backend/internal/storage`, `backend/internal/api` |
| APNs/FCM sender | new `backend/internal/push` |
| Send on new-mail events | `backend/internal/imap` IDLE handler |

No breaking changes to existing web routes.

## Development

```bash
# install all workspaces (shared + mobile)
npm install

# shared + mobile tests
npm test

# typecheck both workspaces
npm run typecheck

# lint the Expo app
npm run lint --workspace @e2mail/mobile

# start the Expo dev server
npm run start --workspace @e2mail/mobile
```

### Simulator and physical device (P1.13)

Need Node 24, the repo-root `npm install`, and either **Expo Go** (login/session
only) or a **development build** (`expo-dev-client` is installed; required for
PGP because of `react-native-quick-crypto`).

1. Start the API (`docker compose up` or `go run ./cmd/server` in `backend/`).
2. From the repo root: `npm run start --workspace @e2mail/mobile`.
3. **iOS Simulator (macOS):** press `i`, or scan the QR code with the Camera
   app on a physical iPhone (same LAN, or tunnel). The app scheme is `e2mail`.
4. **Android emulator / device:** press `a`, or scan the QR code with Expo Go.
   USB devices need `adb devices` to list them first.
5. On the login screen, set **Server URL** to a host the **phone** can reach
   (`http://192.168.x.x:8080`, not `localhost`). `https://` is required if the
   API is only served with TLS; cleartext HTTP needs an ATS / network-security
   exception (not enabled).
6. **Test connection** hits `GET /api/server-config`. A stored Bearer token is
   read from SecureStore on launch; a successful `GET /auth/me` opens the app
   shell. Full email/password login is Phase 4.
7. **PGP needs a development build, not Expo Go.** `react-native-quick-crypto`
   is a native module; run `eas build --profile development` (or `expo prebuild`
   + a local build) before testing Phase 3+ crypto. Login/session still work in
   Expo Go.

EAS: `mobile/eas.json` defines `development` / `development-simulator` /
`preview` / `production`. Use `development-simulator` for an iOS Simulator
`.app` (no paid Apple Developer account; no real APNs).
Run `eas init` in `mobile/` once (needs `EXPO_TOKEN` / an Expo account) to
bind `extra.eas.projectId`. Then `eas build --profile development` for a
dev-client, `preview` for internal Testers, `production` for store binaries.

### On-device PGP smoke + benchmark (P3.3/P3.7)

The app ships a dev-only **Crypto diagnostics** screen
(`app/crypto-diagnostics.tsx`, linked from the home screen when `__DEV__`). It
runs keygen, encrypt+sign, decrypt+verify, detached sign+verify, then
`benchmarkPgp()`, and shares the raw output.

1. `cd mobile && npx eas-cli@latest login` (your Expo account).
2. `npx eas-cli@latest init` once — creates the project and writes
   `extra.eas.projectId` into `app.json`.
3. Build the dev client: Android `npm run build:dev:android` (no Apple account),
   or iOS `npm run build:dev:ios` (needs an Apple Developer account).
4. Install it from the build page/QR, or `npx eas-cli@latest build:run -p android`
   with an emulator running; then `npm start` and open the dev client.
5. Home screen → **Crypto diagnostics (dev)** → **Run smoke + benchmark**.
6. All steps must show `PASS`; copy the benchmark ms into the
   [PGP on React Native](#pgp-on-react-native) baseline and flip `P3.3`/`P3.7`
   to `[x]`.

Web (`frontend/`) and backend keep their existing commands — see `README.md`.

Notes / gotchas:

- The workspace root lockfile is `package-lock.json` (npm workspaces). Commit it.
- `frontend/` still has its own `package-lock.json` and installs independently
  until `P2.1`.
- `expo export` in a non-macOS CI sandbox may fail on the Hermes bytecode step
  if `hermesc` doesn't match the host arch — use `--no-bytecode` for a JS-only
  validation, or run on EAS / macOS.

## CI / CD

- `P1.11` — path-filtered workflow [`.github/workflows/mobile.yml`](.github/workflows/mobile.yml)
  (`mobile/**`, `shared/**`). Uses `expo export --platform web --no-bytecode`
  so Linux CI does not need a matching `hermesc`. Requires Expo web peers
  (`react-native-web`, `react-dom`, `@expo/metro-runtime`); CI failed on
  `c9030d0` until those were added.
- `P1.12` — `mobile/eas.json` (development / development-simulator / preview /
      production). Bind the
  Expo project with `eas init` when credentials exist (`P5.8`).
- `P5.8` — GitHub secret `EXPO_TOKEN` for [`.github/workflows/eas-build.yml`](.github/workflows/eas-build.yml)
  (`workflow_dispatch`). Apple/Android signing stays in EAS credentials; APNs
  `.p8` / FCM JSON are optional if you send through Expo Push (`EXPO_ACCESS_TOKEN`
  on the server raises rate limits). `SESSION_SECRET` must be stable for device
  sessions to survive restarts.
- Existing `container.yml` release tags keep covering backend/web; mobile gets
  its own version channel (`P7.4`).

## Task board

### Phase 0 — Scaffold (done)

- [x] P0.1 Root `package.json` npm workspaces (`shared`, `mobile`)
- [x] P0.2 `@e2mail/shared`: `Platform` adapter, `createMemoryStore`, `joinUrl`
- [x] P0.3 `createHttpClient` (Bearer token, `StandardResponse` envelope, 401 handling)
- [x] P0.4 `createAuthApi` (login, verify-2fa, logout, me, change-password)
- [x] P0.5 REST DTOs (`shared/src/types/api.ts`)
- [x] P0.6 Vitest coverage for the HTTP client (5 tests; auth/joinUrl added in P1.6)
- [x] P0.7 Expo SDK 57 app scaffold with a SecureStore `Platform` (`mobile/`)
- [x] P0.8 Monorepo `metro.config.js` (`watchFolders` + `nodeModulesPaths`)
- [x] P0.9 Probe screen calling `/api/server-config` through the shared client
- [x] P0.10 `MOBILE.md` + root `.gitignore` for Expo/RN artifacts
- [x] P0.11 Commit and push the `mobile` branch

**Acceptance:** `npm test` + `npm run typecheck` pass for **shared**. Bundling
`shared` TS via `expo export --platform web --no-bytecode` is covered in `mobile.yml`.

### Phase 1 — Foundation & toolchain (done)

- [x] P1.1 Navigation: `expo-router` (see [Mobile app design](#mobile-app-design))
- [x] P1.2 `expo-router` + `expo-linking` + `expo-constants`; `scheme`/`plugins` in `app.json`
- [x] P1.3 `zustand` + `@tanstack/react-query` providers
- [x] P1.4 `expo-localization` → `Platform.language`; tiny local `en` / `zh-Hant` map
- [x] P1.5 ESLint + Prettier + `lint`/`typecheck`. Typecheck is TypeScript **7**
      (same as `frontend/`). `eslint-config-expo` / typescript-eslint cannot load
      TS 7 yet (blocked until the 7.1 API); lint uses `@babel/eslint-parser` +
      React hooks rules instead.
- [x] P1.6 RNTL + Jest (`jest-expo`); shared tests for `createAuthApi` / `joinUrl`
- [x] P1.7 App shell: providers, slate/blue tokens, light/dark/system
- [x] P1.8 Error boundary + toast host
- [x] P1.9 `app.json` icons, splash, bundle ids (`com.johnwmail.e2mail`)
- [x] P1.10 Session bootstrap: SecureStore token → `/auth/me` → `/login` or `/(app)`
- [x] P1.11 CI workflow `mobile.yml`, path-filtered on `mobile/**`, `shared/**`
- [x] P1.12 `eas.json` (development / preview / production); `eas init` when Expo account exists
- [x] P1.13 Simulator + physical-device workflow documented above
- [x] P1.14 Split storage: SecureStore for `e2Mail_token`; AsyncStorage for theme / locale / list mode / API URL
- [x] P1.15 Session model: 24h Bearer UUID plus durable device sessions when a push token is registered (`SESSION_SECRET` required across restarts)

**Acceptance:** app boots to a themed shell, routes on stored-token presence,
lint/test/CI run on the mobile package; session/storage decisions are written
down.

### Phase 2 — Shared migration (web parity)

Two PRs. **PR A** (`P2.2`–`P2.6`, `P2.11`) plus web re-pointing via Vite aliases
(`P2.7`–`P2.10`) is done. **`P2.1` (add `frontend` to npm workspaces) remains
open** so the web lockfile and `test.yml` `npm ci` path stay unchanged.

- [ ] P2.1 Add `frontend` to workspaces; reconcile lockfiles and the frontend CI job
- [x] P2.2 Move `types/api.ts`, `types/sieve.ts` → `shared/src/types`
- [x] P2.3 Move `i18n/` + locales → `shared/src/i18n` (inject storage + language)
- [x] P2.4 Move `utils/sieveGenerator.ts` → `shared/src/sieve`
- [x] P2.5 Move business `api/*.ts` → `shared/src/api` (injected `ApiClient`).
      Leave browser `client.ts` / `sse.ts` as adapters. Cover `2fa`, `accounts`,
      `mail`, `addressBook`, `onboarding`, `prefs`, `sieve` — not only auth
- [x] P2.6 Move `api/pgp.ts` → `shared/src/pgp` (MIME rebuild `extractTextFromMime`
      goes with it; RN crypto backend still Phase 3)
- [x] P2.7 Re-point `frontend` imports; delete duplicated locales/modules (thin
      re-exports remain for DOM glue: avatars, attachment URLs, `<a download>`)
- [x] P2.8 Browser `Platform` adapter (`frontend/src/platform.ts`)
- [x] P2.9 Keep web tests green; add shared tests for moved code
- [x] P2.10 Vite/TS aliases for `@e2mail/shared` (workspace package is `P2.1`)
- [x] P2.11 Extract `MessageList` local-search helpers into `shared/src/mail`

**Acceptance:** web and mobile import from `@e2mail/shared`; frontend tests and
Vite build pass. **Still open:** `P2.1` workspace merge.
**Rollback:** revert this commit; web aliases and `frontend/` lockfile are
independent of `P2.1`.

### Phase 3 — Crypto on device

Blocks `P4.11`. Prefer finishing this before compose/send of encrypted mail.

- [x] P3.1 Choose crypto backend (`react-native-quick-crypto`); documented above
- [x] P3.2 Polyfills: quick-crypto `install()`, `global.crypto`, native
      `TextEncoder` (`polyfills.ts` / `polyfills.web.ts`, custom `mobile/index.ts`)
- [~] P3.3 Smoke-test OpenPGP.js: keygen, encrypt, decrypt, sign, verify.
      Node/vitest round-trip is green (`shared/src/pgp/service.test.ts`); the
      dev-only **Crypto diagnostics** screen (`app/crypto-diagnostics.tsx`) runs
      the on-device round-trip — awaiting a dev build
- [x] P3.4 Keyring sync (`/pgp/keyring` GET/POST/DELETE) — `mobile/src/crypto/pgp.ts`
- [x] P3.5 Contact keys (`/pgp/contacts`, bulk, import) — shared service + tests
- [x] P3.6 Passphrase prompt + optional biometric unlock
      (`expo-local-authentication` + SecureStore; `passphrase.ts`,
      `PassphrasePrompt`, mounted in the root layout)
- [~] P3.7 Benchmark harness + Node baseline recorded; `benchmarkPgp()` is wired
      into the diagnostics screen for the mid-range device run

**Acceptance:** round-trip PGP encrypt/decrypt against the web client's keys;
passphrase never persisted in plaintext. Node round-trip is proven; the
on-device acceptance run is the remaining gap.

Extra fix landed with this phase: `parseMultipleKeys` now splits concatenated
ASCII-armored blocks (OpenPGP.js v6 `readKeys` only decodes the first block).

### Phase 4 — Core screens (MVP)

List/detail also need `GET /mail/messages`, `/mail/unread`, `/mail/messages/{uid}`,
`/raw`, `/attachments/{attId}`, `/mail/folders` (same handler as
`/accounts/{id}/folders`). Web uses `/mail/folders?account=`.

- [x] P4.1 Login: server URL, email, password, advanced IMAP/SMTP; prefill from `/server-config`
- [x] P4.2 2FA verify screen (`/auth/verify-2fa`) — same login route after `requires2fa`
- [x] P4.3 Onboarding gate (`/onboarding/status`, `REQUIRE_2FA`/`REQUIRE_PGP`)
- [x] P4.4 Account switcher + folder tree + unread badges
- [x] P4.5 Folder list with prefs/order (`/accounts/{id}/folders*`). Do not call
      `/mail/folders/subscribe`
- [x] P4.6 Message list: pagination, `FlatList` virtualization, messages/threads modes.
      **Search is intentionally out of MVP**
- [x] P4.7 Message detail: headers; HTML body in a WebView with **JS disabled**;
      attachments fetched with **Bearer**; CID → data URI; remote images blocked
      unless allowed (`shared/src/mail/sanitizeHtml.ts`)
- [x] P4.8 Flags: read/star (`/mail/messages/flags`) — invalidate locally
- [x] P4.9 Move / delete / empty folder — invalidate locally
- [x] P4.10 Compose: text/HTML, reply/forward, attachments, drafts (`/mail/drafts`)
- [x] P4.11 Send, including PGP encrypt/sign (`/mail/send`)
- [x] P4.12 Foreground SSE (`/api/events`) via `react-native-sse`, header
      `X-Session-ID`, react-query invalidation on `NEW_MESSAGE`
- [x] P4.13 Offline / error / retry states (query error + retry on list/detail)

**Acceptance:** a user can log in, read, search-free browse, reply, and send
signed/encrypted mail from a phone.

### Phase 5 — Push & background

Depends on `P1.15` if a killed/restarted backend must still notify a logged-in
device.

- [x] P5.1 Backend: device-token table + `/api/push/devices` endpoints + tests
- [x] P5.2 Backend: APNs/FCM sender (`backend/internal/push` via Expo Push API)
- [x] P5.3 Backend: send on new mail (IMAP IDLE hook; INBOX/`NEW_MESSAGE` only
      unless IDLE is extended)
- [x] P5.4 Mobile: `expo-notifications` registration + permission flow
- [x] P5.5 Quiet hours / per-account push preferences
- [x] P5.6 Deep links + app badge count
- [x] P5.7 Background fetch / sync
- [x] P5.8 Secrets: `EXPO_TOKEN` (EAS workflow), optional `EXPO_ACCESS_TOKEN`;
      APNs `.p8` / FCM JSON / Play keystore live in EAS credentials

**Acceptance:** a new message pushes to a backgrounded device and opens the
correct message (or the account Inbox when IMAP does not supply a UID).
Physical-device + APNs/FCM credentials still required to observe a real push.

### Phase 6 — Parity

- [x] P6.1 Accounts management (CRUD, test connection, default, folder prefs/order, junk folder)
- [x] P6.2 Address book (list/resolve/create/update/delete, avatars, import/export)
- [x] P6.3 PGP key management UI, contact keys, keyserver lookup
- [x] P6.4 Sieve: list/edit/activate/deactivate + visual rule builder
- [x] P6.5 Preferences: theme, language, message/thread mode (`/prefs`)
- [x] P6.6 2FA management: setup/enable/disable/backup codes
- [x] P6.7 Change password (LDAP-aware)
- [x] P6.8 Appearance/dark-mode polish + i18n completeness
- [x] P6.9 Accessibility pass (VoiceOver/TalkBack, tap targets, dynamic type)

**Acceptance:** every settings surface the web offers is reachable on mobile.

### Phase 7 — Release

- [ ] P7.1 Final icons/splash + store screenshots
- [ ] P7.2 Store listings + privacy labels. Align copy with
      [`docs/ENCRYPTION.md`](docs/ENCRYPTION.md): PGP payloads are E2E; the
      server still sees IMAP/SMTP credentials, envelope metadata, and
      (unencrypted) mail it proxies
- [ ] P7.3 `eas build` + `eas submit` for App Store / Play (ATS, Play 16 KB
      page size as of target SDK)
- [ ] P7.4 Versioning + changelog aligned with git tags
- [ ] P7.5 Crash/perf monitoring (optional Sentry)

**Acceptance:** signed builds live in both stores; release process documented.

## Risks / open questions

- **Metro + workspace TS**: symlinked `shared/` must be transpiled; the provided
  `metro.config.js` adds repo-root `watchFolders`. Verified in Phase 0.
- **OpenPGP.js on Hermes**: backend chosen (`react-native-quick-crypto`) and
  polyfilled (`P3.1`, `P3.2`); still measure decrypt/sign on a mid-range device
  (`P3.3`, `P3.7`). Highest technical risk for MVP send/decrypt.
- **HTML mail**: no DOMPurify-in-RN. Sanitise before the WebView; never enable
  arbitrary JS; load remote/CID images only through authenticated fetch
  (`P4.7`, [`docs/MAIL-RENDER.md`](docs/MAIL-RENDER.md)).
- **Frontend workspace migration**: adding `frontend` to workspaces changes its
  install/CI. Isolate as PR B (`P2.1`); mobile MVP must not wait on it.
- **App Store 4.2**: a native app avoids the "wrapped website" rejection, but
  push/offline/share extensions strengthen the case.
- **In-memory sessions**: 24h sliding TTL, gone on backend restart. Decide
  durable device sessions in `P1.15` — this is a product blocker for push, not
  an optional Phase 5 extra.
- **SSE auth**: `X-Session-ID`, not Bearer and not `?token=` (`P4.12`).
- **IDLE is INBOX + `NEW_MESSAGE` only**: other folders and flag/expunge
  changes need client-side invalidation.
- **CORS `X-Account`**: not in `AllowedHeaders`. Native fetch is usually fine;
  do not rely on that header from Expo Web until CORS is updated.
- **Folder subscribe 404**: `POST /mail/folders/subscribe` is unimplemented on
  the router; do not port the web call blindly.
- **SecureStore vs prefs**: Phase 0 uses SecureStore for the whole
  `KeyValueStore`; split in `P1.14`.

## Change log

| Date       | Phase | Summary |
|------------|-------|---------|
| 2026-09-10 | P0    | Workspace + `@e2mail/shared` client/auth/types/tests + Expo app shell; pushed on `mobile` |
| 2026-09-10 | docs  | Correct auth/SSE/CORS/session facts; split Phase 2 PRs; P1.14–P1.15; P4.7/P4.12; IDLE and subscribe risks |
| 2026-09-10 | P1    | Expo Router shell, theme/session/storage, lint+test+CI, eas.json; same Bearer session as web |
| 2026-09-10 | P2    | Shared types/i18n/sieve/APIs/PGP/search; web Vite aliases; Expo web peers for `mobile.yml` |
| 2026-09-10 | P3    | quick-crypto polyfills + custom entry, keyring/contact-key wiring, biometric passphrase prompt, PGP round-trip + benchmark tests, `parseMultipleKeys` multi-block fix |
| 2026-09-11 | P4    | Login/2FA/onboarding, mailbox list/detail/compose, PGP send, SSE, HTML sanitiser |
| 2026-09-11 | P5    | Push devices + Expo APNs/FCM, durable device sessions, quiet hours, deep links, background sync, EAS workflow |
| 2026-09-11 | P6    | Native settings hub: accounts, contacts, PGP, Sieve builder, appearance, 2FA, LDAP password |
