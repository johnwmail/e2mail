# Mail Server Configuration

e2Mail can run in two modes:

1. **Fixed server** (recommended for a single mail domain) — users only enter
   email + password; the deployment decides which IMAP/SMTP servers are used.
2. **User-provided server** — the login page exposes advanced server fields
   (or users configure each account under Settings → Accounts).

All mail settings now use the `MAIL_*` names. The old `DEFAULT_*`,
`LOGIN_ALLOWED_DOMAINS`, `OUTBOUND_ALLOWED_HOSTS` and
`ALLOW_PRIVATE_NETWORKS` names were removed and are **not** read anymore.

## Simplest setup

```env
MAIL_SERVER=wonghome.net
MAIL_ALLOWED_DOMAINS=wonghome.net
```

This means:

| Setting | Value |
|---|---|
| IMAP | `wonghome.net:993`, implicit TLS |
| SMTP | `wonghome.net:587`, STARTTLS |
| Login server | **locked** (users cannot override it) |
| Allowed email domains | `wonghome.net` only |
| Self-signed TLS | not allowed |
| Sieve | disabled unless configured |

Users type `abc@wonghome.net` and their password. `abc@not-wonghome.net` is
rejected before any IMAP connection is attempted.

## How `MAIL_SERVER` works

`MAIL_SERVER` is a **hostname**, not an email address and not a domain
allow-list:

```env
MAIL_SERVER=wonghome.net
```

is equivalent to:

```env
MAIL_IMAP_HOST=wonghome.net
MAIL_SMTP_HOST=wonghome.net
```

If IMAP and SMTP use different hosts, override them individually:

```env
MAIL_SERVER=wonghome.net
MAIL_IMAP_HOST=imap.wonghome.net
MAIL_SMTP_HOST=smtp.wonghome.net
```

`MAIL_SERVER` is only used to fill an empty `MAIL_IMAP_HOST` /
`MAIL_SMTP_HOST`; explicit host overrides win.

## Environment reference

| Variable | Default | Purpose |
|---|---|---|
| `MAIL_SERVER` | — | Common IMAP/SMTP host. Fills both hosts |
| `MAIL_MODE` | auto | `locked` = login server cannot be changed; `prefill` = pre-filled but editable. Auto = locked when both hosts are set |
| `MAIL_IMAP_HOST` | — | IMAP host (overrides `MAIL_SERVER`) |
| `MAIL_IMAP_PORT` | `993` | IMAP port |
| `MAIL_SMTP_HOST` | — | SMTP host (overrides `MAIL_SERVER`) |
| `MAIL_SMTP_PORT` | `587` | SMTP port |
| `MAIL_ALLOW_INSECURE_TLS` | `false` | Allow self-signed / unverified IMAP/SMTP certificates |
| `MAIL_ALLOWED_DOMAINS` | — | Comma-separated email domains allowed to sign in. Empty = any domain |
| `MAIL_SIEVE_HOST` | — | Optional ManageSieve host |
| `MAIL_SIEVE_PORT` | `4190` | ManageSieve port |
| `MAIL_SIEVE_USE_TLS` | `true` | Use TLS for ManageSieve |
| `MAIL_SIEVE_ALLOW_INSECURE_TLS` | `false` | Allow self-signed ManageSieve certificates |
| `MAIL_ALLOW_PRIVATE_NETWORKS` | `false` | Allow IMAP/SMTP/Sieve to dial private, loopback and link-local addresses. Keep `false` on shared/public instances |
| `MAIL_OUTBOUND_ALLOWED_HOSTS` | — | Comma-separated exact hosts/IPs that bypass the private-network guard |

`ALLOWED_HOSTS` is unrelated to mail: it is the **HTTP Host allow-list** used
by the web server/reverse proxy.

## Locked vs prefill

```env
# Locked (default when MAIL_SERVER or both hosts are set)
MAIL_SERVER=wonghome.net

# Pre-filled but users may change the server in advanced settings
MAIL_SERVER=wonghome.net
MAIL_MODE=prefill
```

In `locked` mode:

- The login page hides **Advanced server settings**.
- The backend overwrites any client-supplied IMAP/SMTP host, port and
  `allowInsecureTls` with the deployment values, so the lock cannot be bypassed
  by crafting a request.
- Per-account settings under Settings → Accounts can still be edited after
  login.

## Allowed email domains

```env
MAIL_ALLOWED_DOMAINS=wonghome.net,example.com
```

- Domains are case-insensitive; a leading `@` and a trailing `.` are ignored.
- The check runs **before** IMAP authentication. A rejected address never
  reaches the mail server.
- With exactly one allowed domain, typing only `bob` autofills
  `bob@wonghome.net`. With multiple domains, users must enter the full email.
- Empty = no restriction (the IMAP server decides).

## LAN mail servers and the SSRF guard

e2Mail rejects outbound connections to private, loopback, CGNAT, link-local
and cloud-metadata addresses by default. If your mail server really is on the
LAN, use an explicit allow-list:

```env
MAIL_OUTBOUND_ALLOWED_HOSTS=mail.lan,192.168.1.10
```

Only disable the guard entirely for a single-user, fully trusted network:

```env
MAIL_ALLOW_PRIVATE_NETWORKS=true
```

## Docker Compose example

```yaml
services:
  e2mail:
    env_file: .env
```

`.env`:

```env
MAIL_SERVER=wonghome.net
MAIL_ALLOWED_DOMAINS=wonghome.net
COOKIE_SECURE=true
ALLOWED_HOSTS=mail.wonghome.net
```

## OpenBSD `rc.d` example

```sh
rc_start() {
	rc_exec "env \
		PORT=8080 \
		DATA_DIR=/var/e2mail \
		SESSION_SECRET=REPLACE_ME \
		COOKIE_SECURE=true \
		ALLOWED_HOSTS=mail.example.com \
		MAIL_SERVER=mail.example.com \
		MAIL_ALLOWED_DOMAINS=example.com \
		REQUIRE_2FA=true \
		REQUIRE_PGP=true \
		DB_BACKUP=WEEKLY \
		${daemon}${daemon_flags:+ ${daemon_flags}}"
}
```

## Migrating from the old names

Legacy names were removed. Translate them before upgrading:

| Old | New |
|---|---|
| `DEFAULT_IMAP_HOST` / `DEFAULT_IMAP_PORT` | `MAIL_IMAP_HOST` / `MAIL_IMAP_PORT` |
| `DEFAULT_SMTP_HOST` / `DEFAULT_SMTP_PORT` | `MAIL_SMTP_HOST` / `MAIL_SMTP_PORT` |
| `DEFAULT_ALLOW_INSECURE_TLS` | `MAIL_ALLOW_INSECURE_TLS` |
| `DEFAULT_SIEVE_HOST` / `PORT` / `USE_TLS` / `ALLOW_INSECURE_TLS` | `MAIL_SIEVE_HOST` / `PORT` / `USE_TLS` / `ALLOW_INSECURE_TLS` |
| `LOGIN_ALLOWED_DOMAINS` | `MAIL_ALLOWED_DOMAINS` |
| `OUTBOUND_ALLOWED_HOSTS` | `MAIL_OUTBOUND_ALLOWED_HOSTS` |
| `ALLOW_PRIVATE_NETWORKS` | `MAIL_ALLOW_PRIVATE_NETWORKS` |

If both old and new names are present, only the new names take effect.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Login says “email domain is not allowed” | Address not in `MAIL_ALLOWED_DOMAINS` |
| Login says “IMAP host rejected … private/loopback” | Server is on the LAN; add it to `MAIL_OUTBOUND_ALLOWED_HOSTS` |
| Login says “could not detect the mail server” | No fixed server and no advanced host entered |
| Users cannot edit the server | `MAIL_MODE` is `locked`; use `prefill` |
| Advanced settings are hidden unexpectedly | Both hosts are set, so auto-lock is active; set `MAIL_MODE=prefill` |
| TLS errors with an internal server | Avoid `MAIL_ALLOW_INSECURE_TLS=true` unless the certificate cannot be fixed |
