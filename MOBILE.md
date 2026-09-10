# e2Mail Mobile (React Native / Expo)

Plan and workspace notes for a native iOS + Android client that talks to the
existing Go backend. Companion to [`README.md`](README.md) and
[`docs/`](docs/).

> Status: **scaffold** (workspace structure only). Business screens are not
> implemented yet — see [Milestones](#milestones).

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
├── frontend/         React web (Vite; unchanged for now)
├── shared/           @e2mail/shared — platform-agnostic TS
│   └── src/
│       ├── platform.ts       Platform interface + memory store
│       ├── api/client.ts     createHttpClient(platform)
│       ├── api/auth.ts       auth endpoints on top of the client
│       ├── types/api.ts      REST DTOs (source of truth)
│       └── index.ts          public entry
├── mobile/           Expo app (@e2mail/mobile)
│   ├── App.tsx
│   ├── app.json
│   ├── metro.config.js       monorepo watchFolders
│   └── src/…
├── package.json      npm workspaces root (shared + mobile)
└── MOBILE.md         this file
```

`frontend/` is **not** part of the workspace yet, so the existing web build and
CI are untouched. Phase 2 adds it and re-points its imports at `shared/`
(see [Milestones](#milestones)).

## Why a repo folder, not a branch

A native app is a long-lived artifact. A branch would force constant rebases,
make API-contract changes span two lines of history, and break release tagging.
Keep mobile on `main` in `mobile/`; open short feature branches off it.

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
client can later become a thin wrapper that supplies a browser `Platform`.

### What moves to shared/ (Phase 2)

| From `frontend/src`        | To `shared/src`        | Notes                                  |
|----------------------------|------------------------|----------------------------------------|
| `types/api.ts`, `types/sieve.ts` | `types/`         | Pure DTOs, no change                   |
| `api/*.ts`                 | `api/`                 | Swap `import { request }` for injected client |
| `i18n/index.ts` + locales  | `i18n/`                | Locale detection via `Platform.language` |
| `utils/sieveGenerator.ts`  | `sieve/`               | Pure functions                         |
| `api/pgp.ts`               | `pgp/`                 | Needs an RN crypto backend (below)     |

### What stays in the app layer

UI components, navigation, `window`/`document` glue, mail HTML rendering
(the web uses DOM sanitising; mobile should use a WebView **component** for the
message body only — not for the whole app), and push-notification wiring.

## Mobile app design

- **Expo (managed)** + TypeScript. Navigation via `expo-router` or React
  Navigation (decide in Phase 1).
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

### Push notifications (Phase 3)

Requires backend work (there is no APNs path today):

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

## CI / CD (Phase 2)

- Add a path-filtered workflow (`mobile/**`, `shared/**`) so native work does not
  slow the Go/Vitest workflows.
- Build with **EAS Build** (no self-hosted macOS runner needed).
- Store `EXPO_TOKEN`, APNs key, Android keystore in GitHub secrets.
- Existing `container.yml` release tags keep covering backend/web; mobile gets
  its own version channel.

## Milestones

1. **Scaffold (this change)** — workspace, `shared/` types + HTTP client + auth
   endpoints + tests, Expo app booting and calling `/api/server-config`.
2. **Shared migration** — move `api/`, `types/`, `i18n/`, `pgp.ts`,
   `sieveGenerator.ts` into `shared/`; add `frontend` to the workspace and
   re-point imports; web tests stay green.
3. **Core screens** — login + 2FA, folder list, message list, message view
   (WebView body), compose + send with PGP.
4. **Push + background** — device registry, APNs, deep links, badge counts.
5. **Parity** — accounts management, contacts, Sieve, appearance/prefs,
   secure-store passphrase caching with biometrics.

## Risks / open questions

- **Metro + workspace TS**: symlinked `shared/` must be transpiled; the provided
  `metro.config.js` adds repo-root `watchFolders`. Verify early.
- **OpenPGP.js on Hermes**: confirm the chosen crypto polyfill and measure
  decrypt speed on a mid-range device.
- **HTML mail**: sanitise server-side or in the WebView component; never enable
  arbitrary JS.
- **App Store 4.2**: a native app avoids the "wrapped website" rejection, but
  push/offline/share extensions strengthen the case.
- **Two clients, one token model**: decide whether mobile uses the same
  cookie-less Bearer session as the web (already supported) or adds device
  tokens.
