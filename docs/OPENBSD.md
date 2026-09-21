# Running e2Mail on OpenBSD (branch: `OpenBSD`)

Status: **planned / in progress**. Goal: run e2Mail as a **single,
self-contained binary** on OpenBSD with **no Docker**, fronted by OpenBSD's own
TLS termination (`relayd`). This document is written before the code/CI work.

## Why this is feasible

e2Mail's backend is designed to be dependency-light, which maps well onto
OpenBSD:

| Concern | Finding |
|---------|---------|
| CGO | Not required. SQLite is `modernc.org/sqlite` (pure Go). |
| SQLite on OpenBSD | `modernc.org/sqlite` and `modernc.org/libc` ship `openbsd_{amd64,arm64,386}` implementations. |
| Other deps | `go-imap`, `go-message`, `go-ldap`, `go-webauthn`, `circl`, `go-tpm`, `chi`, … are all pure Go. |
| OS-specific code | The only platform call in the backend is `syscall.SIGTERM` (`cmd/server/main.go`). No `/proc`, `/sys`, cgroups, `os/user`, or `os/exec`. |
| Frontend | Embedded with `//go:embed all:dist` (`backend/web/web.go`), so the backend serves the SPA → one file. |
| Runtime deps | `CGO_ENABLED=0` needs no CGO. On OpenBSD the Go linker still links against the **base system `libc`** (`file` reports `dynamically linked, interpreter /usr/libexec/ld.so`), which is always present — no third-party libraries. |

**Cross-compile verified** during planning:

```sh
cd backend
CGO_ENABLED=0 GOOS=openbsd GOARCH=amd64 go build -o /dev/null ./cmd/server   # OK
CGO_ENABLED=0 GOOS=openbsd GOARCH=arm64 go build -o /dev/null ./cmd/server   # OK
```

## Prerequisites / gotchas

1. **The frontend must be built first.** `backend/web/dist/` only contains
   `.gitkeep` in the repo, so a plain `go build` embeds an empty SPA (the
   static handler then returns 404). Build `frontend/dist` and copy it into
   `backend/web/dist/` before compiling, exactly like the Dockerfile does.
2. **There is no TLS listener in the server.** It serves plain HTTP on `:8080`
   (`http.Server.ListenAndServe`). On OpenBSD, terminate TLS with **relayd**
   (or Caddy/nginx). WebAuthn and `Secure` cookies require an `https://` origin.
3. **Go version.** OpenBSD support needs a current Go toolchain (the repo uses
   Go 1.26). If `ports` lags, use the official `go1.26.openbsd-amd64` tarball.
4. **No official OpenBSD build is published** yet — you build it yourself
   (locally or via the CI workflow added on this branch).

## Build

### Option A — cross-compile from any machine (recommended)

```sh
# 1. frontend
cd frontend
npm ci
npm run build

# 2. embed it
rm -rf ../backend/web/dist/*
cp -r dist/* ../backend/web/dist/

# 3. backend (static, openbsd/amd64)
cd ../backend
CGO_ENABLED=0 GOOS=openbsd GOARCH=amd64 go build \
  -ldflags "-s -w \
    -X main.Version=${VERSION:-vdev} \
    -X main.BuildTime=$(date -u +%FT%TZ) \
    -X main.CommitHash=$(git rev-parse --short HEAD)" \
  -o e2mail ./cmd/server
```

`e2mail` is a single, self-contained binary. On OpenBSD, Go links it against the
base system `libc` (`file` shows `dynamically linked, interpreter
/usr/libexec/ld.so`) — always present, so there are no extra runtime
dependencies. `GOARCH=arm64` works too.

### Option B — build natively on OpenBSD

```sh
doas pkg_add go node          # or install the official Go tarball
# then run the same steps as Option A
```

## Deploy

### Dedicated user + data dir

```sh
doas useradd -r -d /var/e2mail -s /sbin/nologin _e2mail
doas install -d -o _e2mail -g _e2mail -m 700 /var/e2mail
doas install -m 0755 e2mail /usr/local/bin/e2mail
```

`/var/e2mail` holds the SQLite DB (`e2Mail.db`) and, if enabled, the
`backups/` directory (`DB_BACKUP`). Same rules as the Docker named volume.

### `rc.d` script

`/etc/rc.d/e2mail`:

```sh
#!/bin/ksh
#
# $OpenBSD$

daemon="/usr/local/bin/e2mail"
daemon_user="_e2mail"
daemon_execdir="/var/e2mail"
daemon_logger="daemon.info"

# --- configuration (keep secrets out of world-readable files) ---
export PORT=8080
export DATA_DIR=/var/e2mail
export SESSION_TTL_HOURS=24
# 32-byte raw / 64-char hex / base64; required for multi-instance or to keep
# device sessions across restarts. Generate: openssl rand -base64 32
export SESSION_SECRET="REPLACE_ME"
export COOKIE_SECURE=true
export REQUIRE_2FA=true
export REQUIRE_PGP=true
export DB_BACKUP=WEEKLY
# export WEBAUTHN_RP_ID=mail.example.com
# export WEBAUTHN_RP_ORIGINS=https://mail.example.com
# export WEBAUTHN_RP_NAME=e2Mail
# export LDAP_ENABLED=true
# export LDAP_URL=ldaps://ldap.example.com:636
# ... see .env.example for the full list

. /etc/rc.d/rc.subr

rc_reload=NO
rc_bg=YES

rc_start() {
	${rcexec} "${daemon} ${daemon_flags}"
}

rc_cmd $1
```

Then:

```sh
doas rcctl enable e2mail
doas rcctl start e2mail
doas rcctl check e2mail
```

`su -m` (used by `rcexec`) preserves the exported environment, so the `export`
lines above reach the daemon. Keep the file `chmod 600` if it contains
`SESSION_SECRET` / `LDAP_ROOT_PW`.

### TLS with relayd

OpenBSD `httpd` is not a general reverse proxy; use **relayd** to terminate TLS
and forward to the app. `/etc/relayd.conf`:

```
ip4="0.0.0.0"

http protocol "e2mail" {
	match request header append "X-Forwarded-For" value "$REMOTE_ADDR"
	match request header append "X-Forwarded-Proto" value "https"
}

relay "e2mail" {
	listen on $ip4 port 443 tls
	protocol "e2mail"
	forward to 127.0.0.1 port 8080
}
```

```sh
doas rcctl enable relayd
doas rcctl restart relayd
```

Set `WEBAUTHN_RP_ORIGINS=https://mail.example.com` (must match the browser
origin exactly) and keep `COOKIE_SECURE=true`.

## CI

`.github/workflows/openbsd.yml` builds the OpenBSD binary from source (frontend
`npm ci && npm run build` → embed → `GOOS=openbsd GOARCH=amd64 CGO_ENABLED=0 go
build`) and uploads it as an artifact. It runs on `workflow_dispatch`, on
pushes to the `OpenBSD` branch, and on `v*` tags (where the binary is attached
to the GitHub release).

## Testing

- Cross-compile must succeed for `openbsd/amd64` (and `arm64`).
- Run the normal backend suite on a host: `cd backend && go test ./...`
  (`CGO_ENABLED=1 go test -race ./...` needs a C compiler).
- On an OpenBSD host, smoke-test: SPA loads, login (IMAP/SMTP), SQLite writes,
  `DB_BACKUP` snapshot, and — if `WEBAUTHN_*` is set — the passkey flow over the
  `https://` origin.

## Risks / open questions

- `modernc.org/sqlite` on OpenBSD is less battle-tested than the C library;
  verify DB create/migrate/backup/restore on the target.
- `pledge(2)`/`unveil(2)` are not reachable from a pure-Go binary without cgo.
  A hardened variant would need an `openbsd`-tagged cgo file (separate build,
  `CGO_ENABLED=1`) — optional, not in the initial scope.
- Go toolchain availability/version on the target; prefer the official tarball.
- `relayd` must forward the client IP (`X-Forwarded-For`) for the login rate
  limiter to key on the real address.
