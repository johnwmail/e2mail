# e2Mail Mobile (React Native / Expo)

Plan, design notes, and the full task board for a native iOS + Android client
that talks to the existing Go backend. Companion to [`README.md`](README.md) and
[`docs/`](docs/).

> **Status: Phase 0 (scaffold) complete.** Workspace, `@e2mail/shared` HTTP
> client + auth API + tests, and an Expo SDK 57 app shell are in place and
> pushed on the `mobile` branch (commit `24ac67c`), pending a PR into `main`.
> Business screens start in Phase 4 — see the [task board](#task-board).

Task-board legend: `[x]` done · `[~]` in progress · `[ ]` todo. IDs (`P4.7`) are
stable references for commits and PRs — use them in commit messages, e.g.
`feat(mobile): message detail WebView (P4.7)`.

## Why React Native

The web client already contains the hard parts as reusable TypeScript:

- the whole REST client + endpoint typings (`frontend/src/api`, `frontend/src/types`),
- **OpenPGP.js** crypto (passphrases never leave the device),
- thread grouping / mail parsing / i18n.

React Native lets us move those into a shared package and render with **native
UI** (no `WKWebView` shell), reusing the crypto instead of rewriting it in
Swift/Kotlin.

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
│       ├── types/api.ts      REST DTOs (source of truth)
│       └── index.ts          public entry
├── mobile/           Expo app (@e2mail/mobile)
│   ├── App.tsx
│   ├── app.json
│   ├── metro.config.js       monorepo watchFolders
│   └── src/platform.ts       SecureStore-backed Platform
├── package.json      npm workspaces root (shared + mobile)
└── MOBILE.md         this file
```

`frontend/` is **not** part of the workspace yet, so the existing web build and
CI are untouched. Phase 2 (`P2.1`) adds it and re-points its imports at
`shared/`.

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
  storage: KeyValueStore;          // localStorage on web, AsyncStorage/SecureStore on device
  language?: string;               // navigator.language | expo-localization
  onUnauthorized?(): void;         // clear token + redirect to login
  translate?(key: string, vars?): string;
}
```

`createHttpClient(platform)` reproduces the browser client's behaviour
(`Bearer` token, JSON envelope, 401 handling) without touching globals. The web
client can later become a thin wrapper that supplies a browser `Platform`
(`P2.8`).

### What moves to shared/ (Phase 2)

| From `frontend/src`        | To `shared/src`        | Task  | Notes                                  |
|----------------------------|------------------------|-------|----------------------------------------|
| `types/api.ts`, `types/sieve.ts` | `types/`         | P2.2  | Pure DTOs, no change                   |
| `api/*.ts`                 | `api/`                 | P2.5  | Swap `import { request }` for injected client |
| `i18n/index.ts` + locales  | `i18n/`                | P2.3  | Locale detection via `Platform.language` |
| `utils/sieveGenerator.ts`  | `sieve/`               | P2.4  | Pure functions                         |
| `api/pgp.ts`               | `pgp/`                 | P2.6  | Needs an RN crypto backend (Phase 3)   |

### What stays in the app layer

UI components, navigation, `window`/`document` glue, mail HTML rendering
(the web uses DOM sanitising; mobile should use a WebView **component** for the
message body only — not for the whole app), and push-notification wiring.

## Mobile app design

- **Expo (managed)** + TypeScript. Navigation: `expo-router` (`P1.1`).
- **State**: reuse the same shape as the web (`zustand` + `@tanstack/react-query`
  both support React Native).
- **Token storage**: `expo-secure-store` (Keychain / Keystore). Never
  `AsyncStorage` for the session token.
- **API auth**: send `Authorization: Bearer <token>`; pick the account with the
  `X-Account` header (see `backend/internal/api/middleware/auth.go:155`).
- **Events**: the web uses SSE (`/api/events`). While the app is foregrounded,
  keep an SSE connection (`react-native-sse`). In the background, rely on
  APNs (below) — iOS will not keep the socket alive.

### PGP on React Native

`openpgp` (OpenPGP.js) targets WebCrypto. On RN it needs a crypto backend and
random source, e.g.:

- `react-native-quick-crypto` (fast, JSI) **or** `@noble/*` primitives, and
- `react-native-get-random-values` for `crypto.getRandomValues`.

Keep the private-key passphrase in memory only, optionally cached in
`expo-secure-store` behind a biometric gate. The backend must keep seeing only
passphrase-encrypted blobs — no server-side crypto changes.

### Push notifications

Requires backend work (there is no APNs path today) — Phase 5:

1. `mobile/` registers for push and uploads the device token.
2. New endpoint(s): store device tokens per user/account, e.g.
   `POST /api/push/devices`, `DELETE /api/push/devices/{token}`.
3. Backend sends APNs/FCM on new mail (hook into the existing IMAP IDLE
   `events` path). Credentials via GitHub secrets / env, never committed.
4. Deep-link the notification to the message (`/messages/{uid}`).

### Backend changes required (all additive)

| Change | Where |
|--------|-------|
| Device-token table + endpoints | `backend/internal/storage`, `backend/internal/api` |
| APNs/FCM sender | new `backend/internal/push` |
| Send on new-mail events | `backend/internal/imap` IDLE handler |
| (optional) `/api/auth/token` for long-lived device sessions | `backend/internal/api/handler/auth.go` |

No breaking changes to existing web routes.

## Development

```bash
# install all workspaces (shared + mobile)
npm install

# shared unit tests
npm test --workspace @e2mail/shared

# typecheck shared
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
- [x] P0.6 Vitest coverage for the HTTP client (5 tests)
- [x] P0.7 Expo SDK 57 app scaffold with a SecureStore `Platform` (`mobile/`)
- [x] P0.8 Monorepo `metro.config.js` (`watchFolders` + `nodeModulesPaths`)
- [x] P0.9 Probe screen calling `/api/server-config` through the shared client
- [x] P0.10 `MOBILE.md` + root `.gitignore` for Expo/RN artifacts
- [x] P0.11 Commit and push the `mobile` branch

**Acceptance:** `npm test` + `npm run typecheck` pass; `expo export` bundles the
shared TS.

### Phase 1 — Foundation & toolchain

- [ ] P1.1 Decide navigation: `expo-router` (recommended) vs React Navigation; document the choice
- [ ] P1.2 Add `expo-router` + `expo-linking` + `expo-constants`; set `scheme`/`plugins` in `app.json`
- [ ] P1.3 Add state libs `zustand` + `@tanstack/react-query`; configure providers
- [ ] P1.4 Add `expo-localization`; feed `Platform.language`; wire shared i18n
- [ ] P1.5 ESLint + Prettier (`eslint-config-expo`); add `npm run lint` for mobile
- [ ] P1.6 React Native Testing Library + a mobile test script
- [ ] P1.7 App shell: providers, theme tokens, light/dark mode matching the web
- [ ] P1.8 Error boundary + toast/snackbar primitives
- [ ] P1.9 Finalise `app.json` (icons, splash, bundle ids, version/channel)
- [ ] P1.10 Session bootstrap: read token → `/auth/me` → route to login vs app
- [ ] P1.11 CI workflow `mobile.yml`, path-filtered on `mobile/**`, `shared/**`
- [ ] P1.12 EAS init + `eas.json` (development / preview / production)
- [ ] P1.13 Document simulator + physical-device workflow in this file

**Acceptance:** app boots to a themed shell, routes on stored-token presence,
lint/test/CI run on the mobile package.

### Phase 2 — Shared migration (web parity)

- [ ] P2.1 Add `frontend` to workspaces; reconcile lockfiles and the frontend CI job
- [ ] P2.2 Move `types/api.ts`, `types/sieve.ts` → `shared/src/types`
- [ ] P2.3 Move `i18n/` + locales → `shared/src/i18n` (inject storage + language)
- [ ] P2.4 Move `utils/sieveGenerator.ts` → `shared/src/sieve`
- [ ] P2.5 Move `api/*.ts` → `shared/src/api` (consume the injected `ApiClient`)
- [ ] P2.6 Move `api/pgp.ts` → `shared/src/pgp` (crypto backend injected)
- [ ] P2.7 Re-point `frontend` imports; delete the duplicated modules
- [ ] P2.8 Browser `Platform` adapter for the web client
- [ ] P2.9 Keep web tests green; add shared tests for moved code
- [ ] P2.10 Adjust `frontend` Vite/TS config for the workspace package

**Acceptance:** `frontend` builds and tests pass with **zero duplicated**
types/api/i18n; both web and mobile import from `@e2mail/shared`.
**Rollback:** keep this in its own PR; if Vite/Metro workspace resolution
misbehaves, revert and keep `shared` mobile-only.

### Phase 3 — Crypto on device

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

- [ ] P4.1 Login: server URL, email, password, advanced IMAP/SMTP; prefill from `/server-config`
- [ ] P4.2 2FA verify screen (`/auth/verify-2fa`)
- [ ] P4.3 Onboarding gate (`/onboarding/status`, `REQUIRE_2FA`/`REQUIRE_PGP`)
- [ ] P4.4 Account switcher + folder tree + unread badges
- [ ] P4.5 Folder list with prefs/order (`/accounts/{id}/folders*`)
- [ ] P4.6 Message list: pagination, virtualization, messages/threads modes
- [ ] P4.7 Message detail: headers, HTML body in a sanitised WebView, attachments
- [ ] P4.8 Flags: read/star (`/mail/messages/flags`)
- [ ] P4.9 Move / delete / empty folder
- [ ] P4.10 Compose: text/HTML, reply/forward, attachments, drafts (`/mail/drafts`)
- [ ] P4.11 Send, including PGP encrypt/sign (`/mail/send`)
- [ ] P4.12 Foreground SSE (`/api/events`) + react-query invalidation
- [ ] P4.13 Offline / error / retry states

**Acceptance:** a user can log in, read, search-free browse, reply, and send
signed/encrypted mail from a phone.

### Phase 5 — Push & background

- [ ] P5.1 Backend: device-token table + `/api/push/devices` endpoints + tests
- [ ] P5.2 Backend: APNs/FCM sender (`backend/internal/push`)
- [ ] P5.3 Backend: send on new mail (IMAP IDLE hook)
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
- [ ] P7.2 Store listings + privacy labels (data collected)
- [ ] P7.3 `eas build` + `eas submit` for App Store / Play
- [ ] P7.4 Versioning + changelog aligned with git tags
- [ ] P7.5 Crash/perf monitoring (optional Sentry)

**Acceptance:** signed builds live in both stores; release process documented.

## Risks / open questions

- **Metro + workspace TS**: symlinked `shared/` must be transpiled; the provided
  `metro.config.js` adds repo-root `watchFolders`. Verified in Phase 0.
- **OpenPGP.js on Hermes**: confirm the chosen crypto polyfill and measure
  decrypt speed on a mid-range device (`P3.1`, `P3.7`).
- **HTML mail**: sanitise server-side or in the WebView component; never enable
  arbitrary JS.
- **Frontend workspace migration**: adding `frontend` to workspaces changes its
  install/CI; isolate in one PR with a clean revert path (`P2.1`).
- **App Store 4.2**: a native app avoids the "wrapped website" rejection, but
  push/offline/share extensions strengthen the case.
- **Two clients, one token model**: decide whether mobile uses the same
  cookie-less Bearer session as the web (already supported) or adds device
  tokens (`P5.1`).

## Change log

| Date       | Phase | Summary |
|------------|-------|---------|
| 2026-09-10 | P0    | Workspace + `@e2mail/shared` client/auth/types/tests + Expo app shell; pushed on `mobile` |
