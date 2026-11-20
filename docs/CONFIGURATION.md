# Mail Server Configuration

e2Mail can run in two modes:

1. **Fixed server** (recommended for a single mail domain) — users only enter
   email + password; the deployment decides which IMAP/SMTP servers are used.
2. **User-provided server** — the login page exposes advanced server fields
   (or users configure each account under Settings → Accounts).

All mail settings now use the `MAIL_*` names. The old `DEFAULT_*`,
`LOGIN_ALLOWED_DOMAINS`, `OUTBOUND_ALLOWED_HOSTS` and
`ALLOW_PRIVATE_NETWORKS` names were removed and are **not** read anymore.
Private, loopback and LAN mail hosts are always blocked; there is no env
override.

`MAIL_ALLOWED_DOMAINS` is optional: in locked mode it defaults to the
`MAIL_SERVER` value, so the simplest deployment only needs `MAIL_SERVER`.

## Simplest setup

```env
MAIL_SERVER=example.com
```

This means:

| Setting | Value |
|---|---|
| IMAP | `example.com:993`, implicit TLS |
| SMTP | `example.com:587`, STARTTLS |
| Login server | **locked** (users cannot override it) |
| Allowed email domains | `example.com` only (auto-derived from `MAIL_SERVER`) |
| Self-signed TLS | not allowed |
| Sieve | disabled unless configured |

Users type `abc@example.com` and their password. `abc@not-example.com` is
rejected before any IMAP connection is attempted.

## How `MAIL_SERVER` works

`MAIL_SERVER` is normally your **mail domain** (the part after `@`). It also
acts as the default IMAP/SMTP hostname:

```env
MAIL_SERVER=example.com
```

is equivalent to:

```env
MAIL_IMAP_HOST=example.com
MAIL_SMTP_HOST=example.com
```

If the real server host is a subdomain such as `mail.example.com`, keep
`MAIL_SERVER` as the email domain and override the operational host/port:

```env
MAIL_SERVER=example.com
MAIL_IMAP_HOST=mail.example.com
MAIL_SMTP_HOST=mail.example.com
```

Users never see these host/port values; they only enter email + password.

If IMAP and SMTP use different hosts, override them individually:

```env
MAIL_SERVER=example.com
MAIL_IMAP_HOST=imap.example.com
MAIL_SMTP_HOST=smtp.example.com
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
| `MAIL_ALLOWED_DOMAINS` | auto | Comma-separated email domains allowed to sign in. Auto = `MAIL_SERVER` when locked; empty otherwise |
| `MAIL_SIEVE_HOST` | — | Optional ManageSieve host |
| `MAIL_SIEVE_PORT` | `4190` | ManageSieve port |
| `MAIL_SIEVE_USE_TLS` | `true` | Use TLS for ManageSieve |
| `MAIL_SIEVE_ALLOW_INSECURE_TLS` | `false` | Allow self-signed ManageSieve certificates |

`HTTP_ALLOWED_HOSTS` is unrelated to mail: it is the **HTTP Host allow-list** used
by the web server/reverse proxy.

## Locked vs prefill

```env
# Locked (default when MAIL_SERVER or both hosts are set)
MAIL_SERVER=example.com

# Pre-filled but users may change the server in advanced settings
MAIL_SERVER=example.com
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

In locked mode, `MAIL_ALLOWED_DOMAINS` defaults to `MAIL_SERVER`:

```env
MAIL_SERVER=example.com
# allowed: abc@example.com
# rejected before IMAP: abc@not-example.com
```

If the server host differs from the email domain, set it explicitly:

```env
MAIL_SERVER=mail.example.com
MAIL_ALLOWED_DOMAINS=example.com
```

- Domains are case-insensitive; a leading `@` and a trailing `.` are ignored.
- The check runs **before** IMAP authentication. A rejected address never
  reaches the mail server.
- With exactly one allowed domain, typing only `bob` autofills
  `bob@example.com`. With multiple domains, users must enter the full email.
- With `MAIL_MODE=prefill`, no domain is auto-derived; set
  `MAIL_ALLOWED_DOMAINS` if you still want a restriction.

## Private / LAN mail servers

e2Mail always rejects outbound connections to private, loopback, CGNAT,
link-local and cloud-metadata addresses. This cannot be disabled by env.
Use a public hostname (or a public reverse proxy) for the mail server.

## Docker Compose example

```yaml
services:
  e2mail:
    env_file: .env
```

`.env`:

```env
MAIL_SERVER=example.com
COOKIE_SECURE=true
HTTP_ALLOWED_HOSTS=mail.example.com
```

## OpenBSD `rc.d` example

```sh
rc_start() {
	rc_exec "env \
		PORT=8080 \
		DATA_DIR=/var/e2mail \
		SESSION_SECRET=REPLACE_ME \
		COOKIE_SECURE=true \
		HTTP_ALLOWED_HOSTS=mail.example.com \
		MAIL_SERVER=example.com \
		MAIL_IMAP_HOST=mail.example.com \
		MAIL_SMTP_HOST=mail.example.com \
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
| `OUTBOUND_ALLOWED_HOSTS` | Removed — private/LAN hosts are not supported |
| `ALLOW_PRIVATE_NETWORKS` | Removed — private/LAN hosts are not supported |

If both old and new names are present, only the new names take effect.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Login says “email domain is not allowed” | Address not in `MAIL_ALLOWED_DOMAINS` |
| Login says “IMAP host rejected … private/loopback” | Server is on the LAN; use a public mail hostname |
| Login says “could not detect the mail server” | No fixed server and no advanced host entered |
| Users cannot edit the server | `MAIL_MODE` is `locked`; use `prefill` |
| Advanced settings are hidden unexpectedly | Both hosts are set, so auto-lock is active; set `MAIL_MODE=prefill` |
| TLS errors with an internal server | Avoid `MAIL_ALLOW_INSECURE_TLS=true` unless the certificate cannot be fixed |
