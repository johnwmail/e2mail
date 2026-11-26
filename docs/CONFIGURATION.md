# Mail Server Configuration

e2Mail can run in two modes:

1. **Fixed server** (recommended for a single mail domain) — users only enter
   email + password; the deployment decides which IMAP/SMTP servers are used.
2. **User-provided server** — the login page exposes advanced server fields
   (or users configure each account under Settings → Accounts).

All mail settings now use the `MAIL_*` names. The old `DEFAULT_*`,
`LOGIN_ALLOWED_DOMAINS`, `OUTBOUND_ALLOWED_HOSTS` and
`ALLOW_PRIVATE_NETWORKS` names were removed and are **not** read anymore.
User-supplied private/loopback/LAN hosts are blocked. Hosts configured by the
administrator (`MAIL_SERVER` / `MAIL_IMAP_HOST` / `MAIL_SMTP_HOST` /
`MAIL_SIEVE_HOST`) are trusted, even if they resolve to a private address.

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
| `MAIL_ALLOW_INSECURE_TLS` | `false` | Allow self-signed / unverified IMAP/SMTP certificates. **Server-controlled only**: client login/account forms cannot change it; on startup all existing accounts are synced to this value |
| `MAIL_ALLOWED_DOMAINS` | auto | Comma-separated email domains allowed to sign in. Auto = `MAIL_SERVER` when locked; empty otherwise |
| `MAIL_SIEVE_HOST` | — | Optional ManageSieve host |
| `MAIL_SIEVE_PORT` | `4190` | ManageSieve port |
| `MAIL_SIEVE_USE_TLS` | `true` | Use TLS for ManageSieve |
| `MAIL_SIEVE_ALLOW_INSECURE_TLS` | `false` | Allow self-signed ManageSieve certificates |

`HTTP_ALLOWED_HOSTS` is unrelated to mail: it is the **HTTP Host allow-list** used
by the web server/reverse proxy.

| Variable | Default | Purpose |
|---|---|---|
| `TRUSTED_PROXY_CIDRS` | empty | Extra reverse-proxy IPs/CIDRs whose `X-Forwarded-For` is trusted (comma-separated). `127.0.0.1`/`::1` are always trusted. Needed when the proxy is not on loopback, e.g. a Docker bridge gateway like `172.17.0.1`. |

### Reverse proxy (nginx) and client IP

Login/2FA rate limits and lockouts are keyed by the **real client IP**. The backend
only believes `X-Forwarded-For` when the TCP peer is trusted (loopback or
`TRUSTED_PROXY_CIDRS`). Recommended nginx block:

```nginx
location / {
    proxy_pass http://127.0.0.1:8080;      # or the container host IP
    proxy_set_header Host $host;
    # Overwrite, do not append: clients must not be able to inject entries
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_buffering off;                   # SSE /api/events
    proxy_read_timeout 3600s;
}
```

If nginx reaches the container through the Docker bridge, the backend sees the
bridge gateway (commonly `172.17.0.1`) as the peer. Either run the container with
`network_mode: host`, or set `TRUSTED_PROXY_CIDRS=172.17.0.1` (use the single
gateway IP, not a whole private range, so other containers cannot spoof it).
Check the `remote=` / peer IP in the logs to confirm which applies.

### Login lockouts

| Scope | Limit | Window | Effect |
|---|---|---|---|
| Client IP | 20 failures | 15 min | Blocks that IP for all accounts |
| Email + IP | 10 failures | 15 min | Blocks that email from that IP only |
| Email (global) | 30 failures | 1 hour | Blocks that email from any IP (against distributed guessing) |

Locks expire automatically as old failures leave the window. There is no manual
unlock; a successful login clears the counters, and a restart clears memory.

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
- With allowed domains, typing only `bob` autofills the domain matching
  `MAIL_SERVER` (or the first allowed domain). Users can still type a full
  address such as `bob@other.example` to override it.
- With `MAIL_MODE=prefill`, no domain is auto-derived; set
  `MAIL_ALLOWED_DOMAINS` if you still want a restriction.

## Private / LAN mail servers

e2Mail rejects private, loopback, CGNAT, link-local and cloud-metadata
addresses for hosts that users can enter (login advanced fields, per-account
settings). Administrator-configured hosts are trusted:

```env
MAIL_SERVER=wonghome.net          # trusted even if it resolves to 192.168.x.x
MAIL_IMAP_HOST=mail.wonghome.net  # trusted
MAIL_SMTP_HOST=mail.wonghome.net  # trusted
```

This allows a LAN mail server without any extra allow-list variable. Other
private hosts remain blocked.

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
| `OUTBOUND_ALLOWED_HOSTS` | Removed — configured `MAIL_*` hosts are trusted instead |
| `ALLOW_PRIVATE_NETWORKS` | Removed — no global disable |

If both old and new names are present, only the new names take effect.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Login says “email domain is not allowed” | Address not in `MAIL_ALLOWED_DOMAINS` |
| Login says “IMAP host rejected … private/loopback” | Host was user-entered; put it in `MAIL_SERVER` / `MAIL_IMAP_HOST` / `MAIL_SMTP_HOST` or use a public hostname |
| Login says “could not detect the mail server” | No fixed server and no advanced host entered |
| Users cannot edit the server | `MAIL_MODE` is `locked`; use `prefill` |
| Advanced settings are hidden unexpectedly | Both hosts are set, so auto-lock is active; set `MAIL_MODE=prefill` |
| TLS errors with an internal server | Avoid `MAIL_ALLOW_INSECURE_TLS=true` unless the certificate cannot be fixed |
