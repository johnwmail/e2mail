# LDAP Password Change (branch: `slapdv3`)

Status: implemented on **`slapdv3`** (OpenLDAP RFC 3062 + extra hash schemes)
and originally on **`ldap`**. Feature is inert until `LDAP_ENABLED=true`.

## Goal

Let a logged-in user change their mail login password from inside e2Mail. The
mail server (Dovecot/Postfix) authenticates against **OpenBSD `ldapd`**, so a
password change must be written back to `ldapd` **and** kept consistent with
e2Mail's local encryption model.

## Why this lives inside e2Mail (not a separate portal app)

e2Mail's login password is not only an IMAP credential — it is the Argon2id
**master key that wraps the per-user DEK**
(`backend/internal/api/handler/auth.go:295` `resolveCredential`). The DEK in
turn protects every secret at rest: PGP private keyrings, 2FA secrets, and each
account's stored IMAP/SMTP password.

Consequence: an out-of-band `ldapd` password change (e.g. from a standalone
portal) would leave e2Mail's `users.wrapped_dek` wrapped with the OLD password.
The next e2Mail login then does:

- new password → IMAP bind succeeds (Dovecot→ldapd), **DEK unwrap fails** →
  user is locked out of their own encrypted mailbox;
- old password → IMAP bind fails (ldapd already has the new password).

Only an in-app change can **atomically** update `ldapd`, re-wrap the DEK, and
refresh the stored account password. e2Mail already holds the DEK in the active
session (encrypted with the server key, independent of the user password), so it
can re-wrap without ever needing the old password for key recovery. A separate
app would need e2Mail's SQLite DB + `SESSION_SECRET` + crypto internals to do
the same — strictly worse coupling and a second privileged surface.

## Target: OpenBSD `ldapd` vs OpenLDAP `slapd`

Verified against `ldapd(8)` / `ldapd.conf(5)` and OpenLDAP’s RFC 3062 Password
Modify:

1. **`ldapd` has no RFC 3062.** It only implements bind/search/compare/add/delete/modify
   (STANDARDS: RFC 4511/4512; "not yet fully LDAPv3 compliant"). Password change
   uses a **Modify** that REPLACES `userPassword`.
2. **`ldapd` does not hash on write.** It stores `userPassword` verbatim and
   only interprets `{SHA}/{SSHA}/{CRYPT}/{BSDAUTH}` when **verifying a bind**.
   Therefore **e2Mail generates `{SSHA}` itself** (`LDAP_PASSWORD_SCHEME=ssha`).
3. **OpenLDAP slapd (v3)** typically **does** hash on write (`olcPasswordHash`)
   and **does** implement RFC 3062. Set `LDAP_PASSWORD_SCHEME=rfc3062`. e2Mail
   sends the new password in the clear over TLS; slapd chooses the algorithm
   (SSHA, SSHA512, Argon2, …). Do **not** also set `ssha` against slapd unless
   you have confirmed it stores RFC 2307 strings as-is (otherwise it may
   double-hash).
4. **Dovecot authenticates by binding** to the directory. The stored scheme
   must be one the directory verifies on bind.
5. **TLS is required for password ops.** Connect via `ldaps://` or STARTTLS.
6. **Service-account change.** Bind as `LDAP_ROOT_DN` / `LDAP_ROOT_PW` (ldapd
   namespace `rootdn`, or any slapd DN with write access to `userPassword`).
   Old-password verification is a separate self-bind as the user DN.

Mail users' `userPassword` on ldapd is stored as native `{SSHA}`/`{SHA}`
(not `{BSDAUTH}`), so a `userPassword` Modify genuinely changes the login
credential.

### `LDAP_PASSWORD_SCHEME`

| Value | Write path | Use |
|-------|------------|-----|
| `ssha` (default) | Modify `userPassword={SSHA}…` | OpenBSD **ldapd** |
| `ssha256` / `ssha512` | Modify `{SSHA256}` / `{SSHA512}` RFC 2307bis | Only if the directory **stores hashed values as-is** |
| `rfc3062` | Password Modify extended op, **no** client hash | OpenLDAP **slapd** (and other LDAPv3 servers with RFC 3062) |

### `{SSHA}` / `{SSHA256}` / `{SSHA512}` format

`"{TAG}" + base64( HASH(newPassword || salt) || salt )`, salt = 16 random
bytes. `{SSHA}` uses SHA-1 (ldapd). `{SSHA256}`/`{SSHA512}` use SHA-256/512.

## Flow: `POST /api/auth/change-password`

Authed endpoint (behind `middleware.Auth`, `backend/internal/api/router.go:53`).
Body: `{ oldPassword, newPassword, confirmPassword, account? }` (`account` =
target account ID for multi-account sessions; omit = login-identity account).

1. Resolve the target account: `account` ID (must belong to the logged-in
   owner) or the login-identity account (`Email == session.Email`). Resolve its
   LDAP entry DN from `LDAP_USER_DN_TEMPLATE` (`%s` = full email, `%u` = local
   part).
2. **Verify old password via self-bind**: connect (TLS) + bind as the user DN
   with `oldPassword`. Failure → `401`. This is the authoritative check and is
   drift-safe (works even if the password was changed outside e2Mail since the
   last login). The DEK is taken from the active session
   (`authCtx.DEK`), not from the old password.
3. **Bind as `rootdn`/`rootpw`** and write the new password:
   - `ssha` / `ssha256` / `ssha512`: **Modify** REPLACE
     `userPassword` with the client-generated RFC 2307 string.
   - `rfc3062`: **Password Modify** extended operation with plaintext
     `newPassword` (slapd hashes).
   Any LDAP failure → abort; **no local state is touched** (user's e2Mail
   keeps working with the old password).
4. On LDAP success, re-sync local state using the SAME DEK (in this order):
   a. (Login-identity account only — its password IS the Master Password) New
      `salt` + `newPassword` → Argon2id MasterKey → wrap the existing DEK →
      `UpdateUserCredential` (`backend/internal/storage/sqlite.go:1111`).
   b. Update the target account row's `EncIMAPPassword`/`EncSMTPPassword` =
      DEK(newPassword) → `UpdateAccount`. When a secondary (non-login) account
      is selected, only its own row changes and step (a) is skipped — the
      Master Password / DEK wrap is untouched.
   c. `refreshSessionAccounts` so the in-memory session reflects new ciphertext.
   d. `poolMgr.DestroyPool` + `idleMgr.StopListener` → `GetOrStartListener` so
      background IMAP connections reconnect with the new password.
5. Respond `{ changed: true }`. The current session stays valid (session DEK is
   encrypted with the server key, not the user password) — **no forced logout**.

### Failure & consistency notes

- LDAP is the source of truth for login. If step 3 succeeds but a step-4 local
  write fails (rare: single SQLite writes), we log an error and return 500; the
  user can log in with the **new** password (IMAP/LDAP already updated). A
  partial-failure guard (verify re-wrap before committing) is included.
- If self-bind succeeds but the local DEK-unwrap assertion disagrees
  (drift), we still proceed using the session DEK and log a warning.

## Configuration (env, `internal/config/config.go`)

| Var | Meaning | Default |
|-----|---------|---------|
| `LDAP_ENABLED` | Master switch; also gates the UI | `false` |
| `LDAP_URL` | `ldaps://…` or `ldap://…:389` (+STARTTLS) | — |
| `LDAP_STARTTLS` | Use STARTTLS on a plain `ldap://` URL | `false` |
| `LDAP_ROOT_DN` | Service/root bind DN (namespace rootdn) | — |
| `LDAP_ROOT_PW` | Root bind password — **secret, env/secret-injected only** | — |
| `LDAP_USER_DN_TEMPLATE` | e.g. `uid=%s,ou=people,dc=example,dc=com` | — |
| `LDAP_PASSWORD_SCHEME`    | `ssha`  | `ssha` = ldapd (client `{SSHA}`); `rfc3062` = OpenLDAP slapd; `ssha256`/`ssha512` = client RFC 2307bis Modify |
| `LDAP_ALLOW_INSECURE_TLS` | Self-signed certs, dev only | `false` |

`LDAP_ROOT_PW` is never logged and never persisted to the DB.

## Files

- `backend/go.mod` — add `github.com/go-ldap/ldap/v3`.
- `backend/internal/config/config.go` — LDAP_* env vars.
- `backend/internal/ldap/client.go` — `HashSSHA`/`HashSSHA256`/`HashSSHA512`,
  `VerifyUserBind`, `ChangePassword` (Modify or RFC 3062).
- `backend/internal/api/handler/auth.go` — `ChangePassword` handler.
- `backend/internal/api/handler/config.go` — expose `ldapEnabled` to SPA.
- `backend/internal/api/router.go` — register the route.
- `frontend/src/api/auth.ts` — `changePassword()`.
- `frontend/src/components/mail/SecurityTab.tsx` — change-password form
  (responsive; old/new/confirm; strength + success/error toasts).
- `.env.example`, `docker-compose.yml` — document vars (rootpw via secret).

## Security

- LDAPS or STARTTLS mandatory; plaintext refused (mirrors `ldapd`).
- Root credentials from env/secret; excluded from logs.
- Old password verified by authoritative self-bind before any change.
- LDAP write precedes local re-wrap (fail closed, no orphaned re-wrap).
- CSRF: existing Bearer/cookie session model; SameSite=Lax already set.
- Rate-limit the endpoint (brute-force on old password).

## Out of scope (v1)

- Using LDAP for **login** (login stays IMAP-bind). Only change-password touches LDAP.
- Active Directory (`unicodePwd`) and `{CRYPT}`/bcrypt/Argon2 **client-side**
  hashes — slapd Argon2 belongs in `olcPasswordHash` with `rfc3062`.
- A standalone self-service portal / nginx `auth_request` SSO — deliberately
  avoided (see "Why this lives inside e2Mail").
- Password history/expiry policy enforcement.

## Testing

- `internal/ldap/client_test.go`: `{SSHA}`/`{SSHA256}`/`{SSHA512}` layout;
  RFC 3062 uses PasswordModify not Modify; error mapping (fake conn).
- Handler tests: self-bind fail → 401; LDAP modify fail → no `UpdateUserCredential`
  / no account change; success → new password unwraps DEK, old password does not.
- Frontend: form validation + API call (Vitest).
- CI: `go test ./... -race`, `npm run test`.

## Rollout

Develop and land on the **`slapdv3`** branch (OpenLDAP write path) or **`ldap`**
(original ldapd work). Enable with `LDAP_ENABLED=true` + LDAP_* env.
`LDAP_PASSWORD_SCHEME=ssha` for ldapd, `rfc3062` for slapd. Feature is inert
(`ldapEnabled=false`) until configured.
