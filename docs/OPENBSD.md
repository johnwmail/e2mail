# Running e2Mail on OpenBSD

Status: **supported**. e2Mail runs as a **single, self-contained binary** on
OpenBSD with **no Docker**, fronted by OpenBSD's own TLS termination (`relayd`).
Release binaries include `openbsd/amd64`.

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
# OpenBSD's useradd has no -r (that is a Linux flag). Use a low system UID via
# -u, -m to create the home, and -g =uid to give the account its own group.
doas useradd -m -u 700 -g =uid -d /var/e2mail -L daemon -s /sbin/nologin _e2mail
doas install -d -o _e2mail -g _e2mail -m 700 /var/e2mail
doas install -m 0755 e2mail /usr/local/bin/e2mail
```

`/var/e2mail` holds the SQLite DB (`e2Mail.db`) and, if enabled, the
`backups/` directory (`DB_BACKUP`). Same rules as the Docker named volume.

### `rc.d` script (single file)

`/etc/rc.d/e2mail` — the only file you need. `rc.subr` starts the daemon
through `su -fl`, which **clears the environment**, so the config is passed
explicitly with `env(1)` from a small `rc_start` override:

```sh
#!/bin/ksh
#
# $OpenBSD$

daemon="/usr/local/bin/e2mail"
daemon_user="_e2mail"
daemon_execdir="/var/e2mail"
daemon_logger="daemon.info"

rc_bg=YES
rc_reload=NO

. /etc/rc.d/rc.subr

# Generate the secret once, then paste it below:
#   openssl rand -base64 32
rc_start() {
	rc_exec "env \
		PORT=8080 \
		DATA_DIR=/var/e2mail \
		SESSION_TTL_HOURS=24 \
		SESSION_SECRET=REPLACE_ME \
		COOKIE_SECURE=true \
		ALLOWED_HOSTS=mail.example.com \
		REQUIRE_2FA=true \
		REQUIRE_PGP=true \
		DB_BACKUP=WEEKLY \
		${daemon}${daemon_flags:+ ${daemon_flags}}"
}

rc_cmd $1
```

- `rc_exec` is the documented hook. Do **not** reference the old global
  `${rcexec}` — it no longer exists in current `rc.subr` and makes start fail.
- Set `ALLOWED_HOSTS` to the public hostname (or comma-separated hostnames) served
  by relayd. The `http protocol` below leaves the incoming `Host` header intact,
  so relayd forwards it to e2Mail by default; do not add a rule that rewrites or
  removes `Host`.
- Add `WEBAUTHN_*`, `LDAP_*`, … as extra `NAME=value \` lines.
- This file holds `SESSION_SECRET`, so keep it `root:wheel` `chmod 600`.

Then:

```sh
doas rcctl enable e2mail
doas rcctl start e2mail
doas rcctl check e2mail
```

If it fails to start, get the real reason with:

```sh
doas rcctl -d start e2mail            # debug output
doas tail -f /var/log/messages        # daemon_logger output
doas -u _e2mail /usr/local/bin/e2mail # run in the foreground as the service user
```

### TLS with relayd

OpenBSD `httpd` is not a general reverse proxy; use **relayd** to terminate TLS
and forward to the app.

TLS certificates (e.g. from `acme-client`) go in `/etc/ssl/mail.example.com.crt`
and `/etc/ssl/private/mail.example.com.key`. `/etc/relayd.conf`:

```
http protocol "e2mail" {
	match request header set "X-Forwarded-For" value "$REMOTE_ADDR"
	match request header append "X-Forwarded-Proto" value "https"
	tls { keypair "mail.example.com" }
}

relay "e2mail" {
	listen on egress port 443 tls
	protocol "e2mail"
	forward to 127.0.0.1 port 8080
}
```

The incoming `Host` header is forwarded unchanged unless a protocol rule changes
or removes it. No special `Host` rule is needed here. Set `ALLOWED_HOSTS` in the
e2Mail service environment to the public hostname (for example,
`ALLOWED_HOSTS=mail.example.com`) so requests for other hostnames receive `421`.
`X-Forwarded-For` is deliberately **set**, not appended: this single-proxy setup
replaces any client-supplied value with relayd's observed client IP. Keep the
backend reachable only through relayd; multi-proxy deployments need an explicit
trusted-proxy chain rather than trusting arbitrary forwarded values.

- `egress` is the interface group of the default-route interface; `listen on
  0.0.0.0` is rejected because `0.0.0.0` is not a local address.
- `keypair` must match the cert/key filename under `/etc/ssl[/private]`, i.e.
  `/etc/ssl/mail.example.com.crt` + `/etc/ssl/private/mail.example.com.key`.
- `acme-client` usually writes `/etc/ssl/acme/fullchain.pem` and
  `/etc/ssl/acme/private/privkey.pem`; symlink them to the names relayd looks for
  (a `keypair` statement cannot take both `cert` and `key` paths at once):
  `doas ln -sf /etc/ssl/acme/fullchain.pem /etc/ssl/mail.example.com.crt`
  `doas ln -sf /etc/ssl/acme/private/privkey.pem /etc/ssl/private/mail.example.com.key`

```sh
doas relayd -n -f /etc/relayd.conf   # config test
doas rcctl enable relayd
doas rcctl start relayd
doas rcctl check relayd
```

Set `WEBAUTHN_RP_ORIGINS=https://mail.example.com` (must match the browser
origin exactly) and keep `COOKIE_SECURE=true`.

## Hardening: unveil(2) + pledge(2) (opt-in)

`golang.org/x/sys/unix` exposes `Pledge`, `PledgePromises`, `Unveil`, and
`UnveilBlock` on OpenBSD (≥ 6.4), so **no cgo is needed**. `cmd/server` applies
them at startup **only when `OPENBSD_HARDEN` is set** (`cmd/server/harden_openbsd.go`);
otherwise it is a no-op (`harden_other.go`). This is opt-in because a
too-narrow path/promise set aborts the process — validate on your host first.

```sh
export OPENBSD_HARDEN=1
# optional overrides:
# export OPENBSD_PLEDGE="stdio rpath wpath cpath inet dns flock fattr tmppath"
# export OPENBSD_UNVEIL_EXTRA="/some/extra/path,/another"
```

Unveiled paths: `$DATA_DIR` (`rwc`), `/etc/ssl` (`r`), `/etc/resolv.conf` (`r`),
`/etc/hosts` (`r`), `/etc/localtime` (`r`), `/usr/share/zoneinfo` (`r`),
`/tmp` (`rwc`), `/dev/null` (`rw`). Then `UnveilBlock()`, then
`Pledge(promises, "")`.

Default promises: `stdio rpath wpath cpath inet dns flock fattr tmppath`
(stdio/kqueue, file read/write/create, TCP, DNS, SQLite locking, chmod, temp
files).

If the daemon dies right after `[HARDEN] ... applied`, widen `OPENBSD_PLEDGE`
(e.g. add `unix`, `getpw`, `route`, `sendfd`, `recvfd`, `proc`) or add paths via
`OPENBSD_UNVEIL_EXTRA`; once stable, make `OPENBSD_HARDEN` the default.

## CI

- `.github/workflows/release.yml` — on **`v*` tags**: builds the static,
  frontend-embedded binary for `linux/amd64`, `linux/arm64` and `openbsd/amd64`
  (frontend `npm ci && npm run build` → embed → `CGO_ENABLED=0 go build
  -trimpath`) and attaches them to the GitHub release.
- `.github/workflows/test.yml` — a `cross-build` matrix (`linux/amd64`,
  `linux/arm64`, `openbsd/amd64`, CGO disabled) compile-checks the backend on
  every push/PR to `main`.

## Testing

- Cross-compile must succeed for `openbsd/amd64` (CI `cross-build` matrix);
  `openbsd/arm64` also builds.
- Run the normal backend suite on a host: `cd backend && go test ./...`
  (`CGO_ENABLED=1 go test -race ./...` needs a C compiler).
- On an OpenBSD host, smoke-test: SPA loads, login (IMAP/SMTP), SQLite writes,
  `DB_BACKUP` snapshot, and — if `WEBAUTHN_*` is set — the passkey flow over the
  `https://` origin. Then test `OPENBSD_HARDEN=1` (see
  [Hardening](#hardening-unveil2--pledge2-opt-in)).

## Risks / open questions

- `modernc.org/sqlite` on OpenBSD is less battle-tested than the C library;
  verify DB create/migrate/backup/restore on the target.
- `pledge(2)`/`unveil(2)` are reachable from pure Go via `golang.org/x/sys/unix`
  (no cgo). The shipped path/promise set is **opt-in** and must be validated on
  the target — see [Hardening](#hardening-unveil2--pledge2-opt-in).
- Go toolchain availability/version on the target; prefer the official tarball.
- `relayd` must forward the client IP (`X-Forwarded-For`) for the login rate
  limiter to key on the real address.
