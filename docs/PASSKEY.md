# Passkey / WebAuthn as a Login Second Factor (branch: `passkey`)

Status: **implemented** on the **`passkey`** branch (branched from `main`). Backend
(config, storage, service, endpoints, login flow) and web UI (login second factor
+ Security settings) are in place; see [Phases](#phases).

## Goal

Let a user add a **passkey** (platform authenticator / device key) and use it as
the **second factor** at login, alongside the existing TOTP authenticator app and
backup codes:

- iPhone / iPad **Face ID / Touch ID** (iCloud Keychain passkey)
- macOS **Touch ID**, Windows **Windows Hello**
- Android **fingerprint / face** (Google Password Manager)
- Hardware **security keys** (YubiKey and other FIDO2/CTAP2 keys)

All of these are served by the same **WebAuthn** browser API. There is no
per-vendor client code.

## Why passkeys are a *second* factor here — not passwordless

e2Mail's login password is **not only an IMAP credential**. It is the Argon2id
**master key that wraps the per-user DEK**:

```
users.salt + login password
        │  DeriveMasterKey()          backend/internal/crypto
        ▼
    master key ── AES-GCM unwrap ──► DEK ──► decrypts keyrings, 2FA secret,
                                             per-account IMAP/SMTP passwords
```

See `backend/internal/api/handler/auth.go:358` (`resolveCredential`) and
`backend/internal/api/handler/auth.go:522` (2FA completion path,
`completeLogin`).

Consequences:

1. The password must reach the server **before** the vault can be unlocked, so a
   passkey **cannot replace** the first step without redesigning key wrapping.
2. WebAuthn assertions prove possession of a private key; they do **not** hand the
   server a symmetric key. Truly passwordless login would require the WebAuthn
   **PRF extension** (or `largeBlob`) to derive a KEK, or storing a server-side
   copy of the DEK. Both are out of scope and have uneven browser support.

Therefore this feature keeps the existing order and only replaces the
**second** step:

```
password ──► IMAP bind (proves mail credential) ──► [ pending login ]
                                                         │
              ┌──────────────────────────────────────────┤
              ▼                                          ▼
        TOTP / backup code                        passkey assertion
              └─────────────── completeLogin() ─────────┘
```

## Decisions

| # | Decision | Choice |
|---|----------|--------|
| 1 | Role | **Second factor only** (password still required first) |
| 2 | Relationship to TOTP | **Coexist** — either method can complete login; each can be enabled/disabled independently |
| 3 | Backend library | `github.com/go-webauthn/webauthn` |
| 4 | Frontend helper | `@simplewebauthn/browser` (frontend only, not shared/mobile) |
| 5 | Relying Party config | **`WEBAUTHN_*` environment variables**; feature disabled when unset |
| 6 | Multiple passkeys per user | Yes (primary device + backup key) |
| 7 | Branch base | `main` (no `mobile/` or `shared/` on this branch) |

## WebAuthn constraints (must hold for this to work)

- **Secure context**: WebAuthn only runs over **HTTPS** (or `localhost` in dev).
  A plain-HTTP LAN deployment cannot use passkeys. This matches the existing
  `COOKIE_SECURE` / CSP assumptions.
- **RP ID**: must be a **registrable-domain suffix of the page origin** and must
  match exactly, e.g. origin `https://mail.example.com` → RP ID
  `mail.example.com` (or `example.com`). It cannot be an IP address.
- **Changing the RP ID / domain invalidates existing passkeys.** The user must
  re-register after a domain move.
- Passkey creation normally prompts for **user verification** (Face ID / PIN /
  fingerprint). We request `userVerification: "preferred"` and do not require it,
  so security keys without a PIN still work as a second factor.

## Backend design

### 1. Config — `backend/internal/config/config.go`

Add `WebAuthn *WebAuthnConfig` to `ServerConfig` (`config.go:11`) with a
nil-safe `Ready()`:

| Env var | Meaning | Example |
|---------|---------|---------|
| `WEBAUTHN_RP_ID` | Relying Party ID | `mail.example.com` |
| `WEBAUTHN_RP_ORIGINS` | Comma-separated allowed origins | `https://mail.example.com` |
| `WEBAUTHN_RP_NAME` | Display name in the OS prompt | `e2Mail` (default) |

`Ready()` returns true only when `RPID != ""` **and** at least one origin is set.
When not ready, all passkey endpoints return `403` and the UI hides the feature
(same pattern as `LDAPConfig.Ready()` at `config.go:55`).

### 2. Storage — `backend/internal/storage/sqlite.go`

New table appended to the `schema` constant (`CREATE TABLE IF NOT EXISTS`, so it
applies to existing databases on next boot; `PRAGMA user_version` stays `2`):

```sql
CREATE TABLE IF NOT EXISTS webauthn_credentials (
  owner_id        TEXT NOT NULL,          -- blind index: crypto.OwnerID(email)
  credential_id   TEXT NOT NULL PRIMARY KEY, -- base64url; lookup only, not secret
  name            TEXT NOT NULL DEFAULT '',  -- user label, e.g. "iPhone Face ID"
  credential_json TEXT NOT NULL,          -- serialized webauthn.Credential (public data)
  created_at      INTEGER NOT NULL,
  last_used_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_webauthn_owner ON webauthn_credentials(owner_id);
```

The **private key never leaves the authenticator**; only public data is stored.
`credential_json` holds the full `webauthn.Credential` record (ID, public key,
`Flags`, sign count, transports, AAGUID, attestation). The `Flags` and sign count
are **required** for assertion verification — the library rejects a login when the
`BackupEligible` flag is inconsistent, and detects cloned authenticators via a
non-increasing sign count — so the whole record must round-trip.

`credential_json` is **not** DEK-wrapped on purpose: it must be read to verify the
second factor, which happens *before* the password unwraps the DEK. It contains
only public data. The storage layer treats it as an opaque JSON string; the
`auth/webauthn` service does the marshal/unmarshal.

`Store` interface additions (`sqlite.go:109`):

```go
ListWebAuthnCredentials(ownerEmail string) ([]WebAuthnCredential, error)
GetWebAuthnCredential(ownerEmail, credentialID string) (*WebAuthnCredential, error)
CreateWebAuthnCredential(c *WebAuthnCredential) error
UpdateWebAuthnCredential(ownerEmail, credentialID, credentialJSON string) error
RenameWebAuthnCredential(ownerEmail, credentialID, name string) error
DeleteWebAuthnCredential(ownerEmail, credentialID string) (int64, error)
CountWebAuthnCredentials(ownerEmail string) (int, error)
```

### 3. Service — `backend/internal/auth/webauthn.go` (new)

- Wraps `webauthn.WebAuthn` (built from the config's RP ID / origins / name).
- A **ceremony store** for in-flight challenges, modeled on
  `PendingLoginStore` (`backend/internal/auth/pending.go`): an in-memory TTL map
  keyed by a `uuid` challenge id holding `webauthn.SessionData`. Separate stores
  (or one namespaced store) for registration and login assertions.

### 4. API — `backend/internal/api/handler/webauthn.go` (new)

Registration / management (**protected**, registered in the group at
`backend/internal/api/router.go:54`):

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/2fa/webauthn` | List the user's credentials (+ count) |
| `POST` | `/api/2fa/webauthn/register/begin` | Return `PublicKeyCredentialCreationOptions` |
| `POST` | `/api/2fa/webauthn/register/finish` | Verify attestation, store public key |
| `PATCH` | `/api/2fa/webauthn/{id}` | Rename a credential |
| `DELETE` | `/api/2fa/webauthn/{id}` | Remove a credential |

Login (**public**, next to `router.go:46`):

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/auth/webauthn/begin` | Body `{ challenge }` (pending-login id) → assertion options with `allowCredentials` for that user |
| `POST` | `/api/auth/webauthn/verify` | Body `{ challenge, assertion }` → on success call `completeLogin()` (`auth.go:519`) |

### 5. Login-flow changes

- `auth.go:256`: the `requires2fa` branch currently triggers on
  `GetTwoFA(email) != nil`. Extend it to also trigger when
  `CountWebAuthnCredentials(email) > 0`, so a passkey-only user still gets a
  second step.
- `LoginResponse` (`auth.go:178`) gains `methods []string` (e.g.
  `["totp","webauthn"]`). `requires2fa` and `challenge` stay for backward
  compatibility.
- `completeLogin()` is reused unchanged — the pending login already holds the
  password needed to unwrap the DEK.
- `/api/2fa/status` (`auth2fa.go:52`) gains `webauthnEnabled` + `passkeyCount`;
  onboarding (`Require2FA`) treats a registered passkey as satisfying the 2FA
  requirement.

### 6. Security

- Origin / RP ID are validated by `go-webauthn` from the configured values — we
  **never** trust the request `Host` / `X-Forwarded-*` to pick the RP ID.
- The passkey verify endpoint reuses the existing rate limiter
  (`pwLimiter`, `backend/internal/auth/attempts.go`), like `Verify2FA`
  (`auth.go:105`).
- **Sign counter**: `go-webauthn` sets `Authenticator.CloneWarning` when the
  assertion counter does not advance (the "possible cloned authenticator"
  signal) and the updated record is written back. It does **not** reject the
  ceremony, and we do not reject on it either: many synced platform passkeys
  always report `signCount = 0`, so hard-rejecting would lock out legitimate
  users. Treat `CloneWarning` as an audit signal, not a gate.
- Completing with **any** enabled method (TOTP, backup code, or passkey) is
  accepted, which is standard multi-factor behaviour and keeps backup codes as a
  fallback.
- CSRF posture is unchanged: `HttpOnly` session cookie + `SameSite=Lax`
  (`auth.go:76`), and WebAuthn binds the ceremony to the origin.

## Frontend design

No `shared/` package on this branch — changes are web-only.

- `frontend/package.json`: add `@simplewebauthn/browser`.
- `frontend/src/types/api.ts`: add `WebAuthnCredential`, begin/finish request and
  response types, and `LoginResponse.methods`.
- `frontend/src/api/webauthn.ts` (new): thin wrappers over `request()` from
  `frontend/src/api/client.ts`; the actual `navigator.credentials` call happens
  in the component via `startRegistration()` / `startAuthentication()`.
- `frontend/src/components/auth/LoginForm.tsx`: in the 2FA step add a
  **“Use Face ID / device key”** button next to the 6-digit field. Guard with a
  `window.PublicKeyCredential` capability check; hide the button on unsupported
  browsers. TOTP + backup code remain the fallback.
- `frontend/src/components/mail/SecurityTab.tsx`: new **Passkeys** section
  (register, list, rename, delete) alongside the existing TOTP UI, each
  independently enable/disable.
- `frontend/src/i18n/locales/{en,zh-Hant}.ts`: new strings.
- Responsive: all new UI must be verified on a mobile viewport (per `AGENTS.md`),
  with touch-friendly targets and no hover-only affordances.

## Environment / deployment

`.env.example` and `docker-compose.yml` comments (and the `README.md` env table):

```dotenv
# Passkey / WebAuthn second factor (leave unset to disable)
# Must be HTTPS and the RP ID must match the origin's registrable domain.
WEBAUTHN_RP_ID=mail.example.com
WEBAUTHN_RP_ORIGINS=https://mail.example.com
WEBAUTHN_RP_NAME=e2Mail
```

## Testing

- **Backend end-to-end**: `internal/api/handler/webauthn_e2e_test.go` drives a full
  **register → login** ceremony through the real HTTP handlers using
  [`descope/virtualwebauthn`](https://github.com/descope/virtualwebauthn) as a
  virtual authenticator (`TestWebAuthnE2ERegisterThenLogin`), plus a
  single-use / unknown-challenge guard test. This validates the
  `go-webauthn` ↔ standard WebAuthn JSON round-trip without a browser.
- **Backend unit**: config `Ready()` gating; storage CRUD + owner isolation;
  ceremony store single-use/TTL; handler input validation.
- **Frontend**: `LoginForm` passkey button render + capability fallback;
  `SecurityTab` list/register/delete; run `npm run test` and `npm run typecheck`.
- **Manual**: iPhone Safari (Face ID), Android Chrome, Windows Hello, and a
  YubiKey across a real HTTPS origin.
- **Gates before push**: `go test ./... -race`, `golangci-lint run ./...` in
  `backend/`, and the frontend Vitest suite.

## Phases

- **P1 — foundation**: `WEBAUTHN_*` config + `Ready()`; `webauthn_credentials`
  table + `Store` CRUD (+ tests).
- **P2 — registration**: `go-webauthn` service + ceremony store; register
  begin/finish, list, rename, delete endpoints; `SecurityTab` passkey UI; i18n.
- **P3 — login**: `/api/auth/webauthn/begin` + `/verify`; `methods` on
  `LoginResponse`; `LoginForm` passkey button and capability fallback.
- **P4 — hardening & docs**: sign-counter write-back, rate-limit wiring,
  onboarding/`2fa/status` integration, README/`.env.example`/`docker-compose`
  updates, manual device matrix.

## Open questions / risks

- **HTTPS is mandatory**; a plain-HTTP deployment simply cannot use passkeys.
- **RP ID is bound to the domain** — moving domains forces re-registration.
- `go-webauthn` version must be confirmed compatible with Go 1.26 (`go get`
  verifies this in P1). **Verified: `github.com/go-webauthn/webauthn v0.18.1`
  builds on Go 1.26.**
- Whether a passkey-only user (no TOTP) should still receive backup codes —
  recommended: yes, keep the existing backup-code flow.

## References

- `backend/internal/api/handler/auth.go:192` — `Login`
- `backend/internal/api/handler/auth.go:256` — 2FA trigger / pending login
- `backend/internal/api/handler/auth.go:358` — `resolveCredential` (DEK wrap)
- `backend/internal/api/handler/auth.go:519` — `completeLogin`
- `backend/internal/api/handler/auth2fa.go` — TOTP setup/enable/disable/backup
- `backend/internal/auth/{totp.go,pending.go,attempts.go}` — 2FA primitives
- `backend/internal/storage/sqlite.go:169` — `users` (wrapped DEK)
- `backend/internal/storage/sqlite.go:178` — `two_fa`
- `backend/internal/config/config.go:11` — `ServerConfig`
- `backend/internal/api/router.go:46` — public auth routes
- `backend/internal/api/router.go:62` — protected `2fa/*` routes
- `backend/internal/api/middleware/auth.go` — session / DEK middleware
- `frontend/src/components/auth/LoginForm.tsx` — 2FA step UI
- `frontend/src/components/mail/SecurityTab.tsx` — security settings UI
- `frontend/src/api/2fa.ts`, `frontend/src/api/client.ts` — API layer
- `frontend/src/types/api.ts:141` — `LoginResponse`
- `docs/LDAP.md` — precedent for a login/credential feature on its own branch
