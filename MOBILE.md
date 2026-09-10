# e2Mail Mobile (React Native / Expo)

Plan, design notes, and the full task board for a native iOS + Android client
that talks to the existing Go backend. Companion to [`README.md`](README.md) and
[`docs/`](docs/).

> **Status: Phase 0 (scaffold) complete.** Workspace, `@e2mail/shared` HTTP
> client + auth API + tests, and an Expo SDK 57 app shell are on the `mobile`
> branch, pending a PR into `main`. Probe screen subtitle still says
> “Phase 1”; that is copy, not progress. Business screens start in Phase 4 —
> see the [task board](#task-board).
>
> Root `npm test` / `npm run typecheck` cover **shared only**. Mobile has no
> `typecheck` / `lint` / `test` scripts yet (`P1.5`, `P1.6`). `expo export`
> as a Hermes-bytecode acceptance check is still unverified on this host.

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
├── frontend/         React web (Vite; not in the workspace yet)
├── shared/           @e2mail/shared — platform-agnostic TS
│   └── src/
│       ├── platform.ts       Platform interface + memory store + joinUrl
│       ├── api/client.ts     createHttpClient(platform)
│       ├── api/auth.ts       auth endpoints on top of the client
│       ├── api/client.test.ts
│       ├── types/api.ts      REST DTOs (copied; still duplicated in frontend)
│       └── index.ts          public entry
├── mobile/           Expo app (@e2mail/mobile)
│   ├── index.ts              Expo entry
│   ├── App.tsx               Phase 0 probe screen
│   ├── app.json
│   ├── metro.config.js       watchFolders + nodeModulesPaths
│   └── src/platform.ts       SecureStore-backed Platform (token store)
├── package.json      npm workspaces root (shared + mobile)
├── package-lock.json
└── MOBILE.md         this file
```

`frontend/` is **not** part of the workspace yet, so the existing web build and
CI are untouched. Adding it (`P2.1`) is a separate, revertible PR — it does
**not** block Phase 3–4. Until then, copy or extract modules into `shared/`
and leave `frontend/` on its own lockfile.

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
touching globals. The web client can later become a thin wrapper that supplies
a browser `Platform` (`P2.8`).

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
| `types/api.ts`, `types/sieve.ts` | `types/`         | P2.2  | `api.ts` already copied; keep in sync  |
| `i18n/` + locales          | `i18n/`                | P2.3  | Locale via `Platform.language` + storage |
| `utils/sieveGenerator.ts`  | `sieve/`               | P2.4  | Pure functions                         |
| `api/*.ts` except glue     | `api/`                 | P2.5  | Injected `ApiClient`; see stay-in-app  |
| `api/pgp.ts`               | `pgp/`                 | P2.6  | Needs an RN crypto backend (Phase 3)   |

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

- **Expo (managed)** + TypeScript. Navigation: `expo-router` (`P1.1`).
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

### Session lifetime (product decision — do not defer to Phase 5)

Backend sessions are **in-memory UUIDs**, default TTL 24h
(`SESSION_TTL_HOURS`), sliding via `Touch` on authenticated requests.
**Process restart logs everyone out.** That is acceptable for a same-origin
SPA; it is a poor phone UX (and blocks “open from a push after the server
restarted”). Decide in `P1.15` whether MVP keeps this model or adds a durable
device session (`/api/auth/token` or equivalent) **before** shipping push.
Phase 5 push tokens are a different table; they do not replace login sessions.

### PGP on React Native

`openpgp` (OpenPGP.js v6) targets WebCrypto. On RN it needs a crypto backend
and random source, e.g.:

- `react-native-quick-crypto` (fast, JSI) **or** `@noble/*` primitives, and
- `react-native-get-random-values` for `crypto.getRandomValues`.

Keep the private-key passphrase in memory only, optionally cached in
`expo-secure-store` behind a biometric gate. The backend must keep seeing only
passphrase-encrypted blobs — it wraps those blobs with the session DEK; it
does not run OpenPGP on mail.

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

# shared unit tests
npm test --workspace @e2mail/shared

# typecheck shared (mobile has no typecheck script until P1.5)
npm run typecheck --workspace @e2mail/shared

# start the Expo dev server
npm run start --workspace @e2mail/mobile
# → press i for iOS simulator, a for Android
```

Web (`frontend/`) and backend keep their existing commands — see `README.md`.

Notes / gotchas:

- The workspace root lockfile is `package-lock.json` (npm workspaces). Commit it.
- `frontend/` still has its own `package-lock.json` and installs independently
  until `P2.1`.
- `expo export` in a non-macOS CI sandbox may fail on the Hermes bytecode step
  if `hermesc` doesn't match the host arch — use `--no-bytecode` for a JS-only
  validation, or run on EAS / macOS.

## CI / CD

- `P1.11` — add a path-filtered workflow (`mobile/**`, `shared/**`) so native
  work does not slow the Go/Vitest workflows.
- `P1.12` — build with **EAS Build** (no self-hosted macOS runner needed).
- `P5.8` — store `EXPO_TOKEN`, APNs key, Android keystore in GitHub secrets.
- Existing `container.yml` release tags keep covering backend/web; mobile gets
  its own version channel (`P7.4`).

## Task board

### Phase 0 — Scaffold (done)

- [x] P0.1 Root `package.json` npm workspaces (`shared`, `mobile`)
- [x] P0.2 `@e2mail/shared`: `Platform` adapter, `createMemoryStore`, `joinUrl`
- [x] P0.3 `createHttpClient` (Bearer token, `StandardResponse` envelope, 401 handling)
- [x] P0.4 `createAuthApi` (login, verify-2fa, logout, me, change-password)
- [x] P0.5 REST DTOs (`shared/src/types/api.ts`)
- [x] P0.6 Vitest coverage for the HTTP client (5 tests; no `createAuthApi` tests yet)
- [x] P0.7 Expo SDK 57 app scaffold with a SecureStore `Platform` (`mobile/`)
- [x] P0.8 Monorepo `metro.config.js` (`watchFolders` + `nodeModulesPaths`)
- [x] P0.9 Probe screen calling `/api/server-config` through the shared client
- [x] P0.10 `MOBILE.md` + root `.gitignore` for Expo/RN artifacts
- [x] P0.11 Commit and push the `mobile` branch

**Acceptance:** `npm test` + `npm run typecheck` pass for **shared**. Bundling
`shared` TS via `expo export` is still an outstanding check (see Hermes note).

### Phase 1 — Foundation & toolchain

- [ ] P1.1 Decide navigation: `expo-router` (recommended) vs React Navigation; document the choice
- [ ] P1.2 Add `expo-router` + `expo-linking` + `expo-constants`; set `scheme`/`plugins` in `app.json`
- [ ] P1.3 Add state libs `zustand` + `@tanstack/react-query`; configure providers
- [ ] P1.4 Add `expo-localization`; set `Platform.language`. Do **not** wait on
      shared i18n catalogs (those move in `P2.3`); hard-code or a tiny local map is fine
- [ ] P1.5 ESLint + Prettier (`eslint-config-expo`); add `lint` + `typecheck` scripts for mobile
- [ ] P1.6 React Native Testing Library + mobile `test` script; add shared tests for
      `createAuthApi` / `joinUrl` (P0.6 only covers the HTTP client)
- [ ] P1.7 App shell: providers, theme tokens, light/dark mode matching the web
- [ ] P1.8 Error boundary + toast/snackbar primitives
- [ ] P1.9 Finalise `app.json` (icons, splash, bundle ids, version/channel)
- [ ] P1.10 Session bootstrap: read token → `/auth/me` → route to login vs app
- [ ] P1.11 CI workflow `mobile.yml`, path-filtered on `mobile/**`, `shared/**`
- [ ] P1.12 EAS init + `eas.json` (development / preview / production)
- [ ] P1.13 Document simulator + physical-device workflow in this file
- [ ] P1.14 Split storage: SecureStore for `e2Mail_token` only; AsyncStorage (or
      equivalent) for theme / locale / list mode
- [ ] P1.15 **Decide session model** for mobile: same 24h in-memory Bearer UUID
      as the web, or additive durable device sessions. Document the choice here;
      implement backend work in the same PR if durable sessions are required
      for MVP. Do not postpone this until push (`P5.1`)

**Acceptance:** app boots to a themed shell, routes on stored-token presence,
lint/test/CI run on the mobile package; session/storage decisions are written
down.

### Phase 2 — Shared migration (web parity)

Two PRs. **PR A** (`P2.2`–`P2.6`, `P2.11`): grow `shared/` so mobile can import
modules; `frontend/` may keep copies until PR B. **PR B** (`P2.1`, `P2.7`–`P2.10`):
add `frontend` to workspaces and delete duplicates. PR B can land **after**
Phase 4 MVP if Vite/CI risk is too high.

- [ ] P2.1 Add `frontend` to workspaces; reconcile lockfiles and the frontend CI job (PR B)
- [ ] P2.2 Move `types/api.ts`, `types/sieve.ts` → `shared/src/types`
- [ ] P2.3 Move `i18n/` + locales → `shared/src/i18n` (inject storage + language)
- [ ] P2.4 Move `utils/sieveGenerator.ts` → `shared/src/sieve`
- [ ] P2.5 Move business `api/*.ts` → `shared/src/api` (injected `ApiClient`).
      Leave browser `client.ts` / `sse.ts` as adapters. Cover `2fa`, `accounts`,
      `mail`, `addressBook`, `onboarding`, `prefs`, `sieve` — not only auth
- [ ] P2.6 Move `api/pgp.ts` → `shared/src/pgp` (crypto backend injected; MIME
      rebuild `extractTextFromMime` goes with it)
- [ ] P2.7 Re-point `frontend` imports; delete the duplicated modules (PR B)
- [ ] P2.8 Browser `Platform` adapter for the web client (PR B)
- [ ] P2.9 Keep web tests green; add shared tests for moved code
- [ ] P2.10 Adjust `frontend` Vite/TS config for the workspace package (PR B)
- [ ] P2.11 Optional: extract `MessageList` local-search helpers into `shared/`

**Acceptance (PR B):** `frontend` builds and tests pass with **zero duplicated**
types/api/i18n; both web and mobile import from `@e2mail/shared`.
**Rollback:** PR B is its own revert; if Vite/Metro workspace resolution
misbehaves, keep `shared` mobile-only and retain frontend copies.

### Phase 3 — Crypto on device

Blocks `P4.11`. Prefer finishing this before compose/send of encrypted mail.

- [ ] P3.1 Choose crypto backend (`react-native-quick-crypto` vs `@noble/*`); document
- [ ] P3.2 Polyfills: `react-native-get-random-values`, `global.crypto`, `TextEncoder`/`TextDecoder`
- [ ] P3.3 Smoke-test OpenPGP.js: keygen, encrypt, decrypt, sign, verify on device
- [ ] P3.4 Keyring sync (`/pgp/keyring` GET/POST/DELETE)
- [ ] P3.5 Contact keys (`/pgp/contacts`, bulk, import)
- [ ] P3.6 Passphrase prompt + optional biometric unlock (`expo-local-authentication` + SecureStore)
- [ ] P3.7 Benchmark decrypt/sign on a mid-range device; record thresholds

**Acceptance:** round-trip PGP encrypt/decrypt against the web client's keys;
passphrase never persisted in plaintext.

### Phase 4 — Core screens (MVP)

List/detail also need `GET /mail/messages`, `/mail/unread`, `/mail/messages/{uid}`,
`/raw`, `/attachments/{attId}`, `/mail/folders` (same handler as
`/accounts/{id}/folders`). Web uses `/mail/folders?account=`.

- [ ] P4.1 Login: server URL, email, password, advanced IMAP/SMTP; prefill from `/server-config`
- [ ] P4.2 2FA verify screen (`/auth/verify-2fa`)
- [ ] P4.3 Onboarding gate (`/onboarding/status`, `REQUIRE_2FA`/`REQUIRE_PGP`)
- [ ] P4.4 Account switcher + folder tree + unread badges
- [ ] P4.5 Folder list with prefs/order (`/accounts/{id}/folders*`). Do not call
      `/mail/folders/subscribe`
- [ ] P4.6 Message list: pagination, virtualization, messages/threads modes.
      **Search is intentionally out of MVP** (`?q=` already exists on the
      backend; add a later task if needed)
- [ ] P4.7 Message detail: headers; HTML body in a WebView with **JS disabled**;
      attachments fetched with **Bearer** (no cookie, no `<img src=/api/...>`).
      Feed body/images via blob or file URI. Web uses DOMPurify + iframe;
      RN has no DOM — sanitise before `srcDoc` / injected HTML (see
      [`docs/MAIL-RENDER.md`](docs/MAIL-RENDER.md))
- [ ] P4.8 Flags: read/star (`/mail/messages/flags`) — invalidate locally
- [ ] P4.9 Move / delete / empty folder — invalidate locally
- [ ] P4.10 Compose: text/HTML, reply/forward, attachments, drafts (`/mail/drafts`)
- [ ] P4.11 Send, including PGP encrypt/sign (`/mail/send`) — **requires Phase 3**
- [ ] P4.12 Foreground SSE (`/api/events`) via `react-native-sse` **or** fetch
      stream, header `X-Session-ID`, react-query invalidation on `NEW_MESSAGE`.
      Treat other event types as optional
- [ ] P4.13 Offline / error / retry states

**Acceptance:** a user can log in, read, search-free browse, reply, and send
signed/encrypted mail from a phone.

### Phase 5 — Push & background

Depends on `P1.15` if a killed/restarted backend must still notify a logged-in
device.

- [ ] P5.1 Backend: device-token table + `/api/push/devices` endpoints + tests
- [ ] P5.2 Backend: APNs/FCM sender (`backend/internal/push`)
- [ ] P5.3 Backend: send on new mail (IMAP IDLE hook; INBOX/`NEW_MESSAGE` only
      unless IDLE is extended)
- [ ] P5.4 Mobile: `expo-notifications` registration + permission flow
- [ ] P5.5 Quiet hours / per-account push preferences
- [ ] P5.6 Deep links + app badge count
- [ ] P5.7 Background fetch / sync
- [ ] P5.8 Secrets: `EXPO_TOKEN`, APNs `.p8`, FCM service account, Android keystore

**Acceptance:** a new message pushes to a backgrounded device and opens the
correct message.

### Phase 6 — Parity

- [ ] P6.1 Accounts management (CRUD, test connection, default, folder prefs/order, junk folder)
- [ ] P6.2 Address book (list/resolve/create/update/delete, avatars, import/export)
- [ ] P6.3 PGP key management UI, contact keys, keyserver lookup
- [ ] P6.4 Sieve: list/edit/activate/deactivate + visual rule builder
- [ ] P6.5 Preferences: theme, language, message/thread mode (`/prefs`)
- [ ] P6.6 2FA management: setup/enable/disable/backup codes
- [ ] P6.7 Change password (LDAP-aware)
- [ ] P6.8 Appearance/dark-mode polish + i18n completeness
- [ ] P6.9 Accessibility pass (VoiceOver/TalkBack, tap targets, dynamic type)

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
- **OpenPGP.js on Hermes**: confirm the chosen crypto polyfill and measure
  decrypt speed on a mid-range device (`P3.1`, `P3.7`). Highest technical risk
  for MVP send/decrypt.
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
