# e2mail

Self-hosted, end-to-end encrypted webmail client. Speaks IMAP/SMTP to any mail
provider, stores PGP key material in a single SQLite file, and serves the SPA
and the API from a single Go binary in one container.

## Features

- **Any IMAP/SMTP server** — Gmail, Outlook, Fastmail, iCloud, QQ, custom
  domains, or a self-hosted mail server. Built-in adaptive table for common
  providers.
- **End-to-end PGP** (OpenPGP.js, Ed25519) — generate, import, encrypt, sign,
  decrypt, verify. Multi-block / multi-key / armored-or-binary `.gpg` files
  are all parsed and re-armored before send.
- **Server-side keyring** — passphrases never leave the browser; the server
  only stores the user's Passphrase-encrypted private key blob.
- **Per-user contact keyrings** stored in SQLite, shared across browsers.
- **Real-time push** via IMAP IDLE → SSE on `/api/events`.
- **One-file storage** — `/data/webmail.db` (with WAL siblings). Legacy
  per-user JSON keyring files are auto-migrated on first boot.
- **Container env defaults** — IMAP/SMTP host & port can be pre-configured by
  the admin so users don't have to fill the advanced settings.
- **Secure by default** — `allowInsecureTls` is off unless explicitly enabled.

## Architecture

```
┌──────────────┐      HTTP      ┌──────────────────────────────────┐
│  Browser UI  │ ◀────────────▶ │  Single Go binary (chi) :8080     │
│  React + Vite│   /api/*       │  - serves embedded SPA (go:embed) │
└──────────────┘                │  - HTTP API                      │
                                │  - IMAP client pool + IDLE        │
                                │  - SMTP sender                   │
                                │  - Sessions (in-memory, AES)     │
                                │  - SQLite storage                │
                                └──────────────┬───────────────────┘
                                               │
                                               ▼
                                /data/webmail.db  (named volume)
```

The frontend `dist/` (React 18 + Vite + Tailwind) is built during the Docker
image build and `go:embed`-ed into the backend binary (`backend/web`), so the
container runs a single process serving both the SPA and the API.

| Service  | Tech                                            | Port (host) |
|----------|-------------------------------------------------|-------------|
| webmail  | Go 1.25 + chi + modernc.org/sqlite, embeds the Vite build | `8080`      |

## Quick start

```bash
# Clone
git clone <repo-url> e2mail
cd e2mail

# Build & run
docker compose up -d --build

# Open
open http://localhost:8080      # webmail UI (SPA + API on one port)
curl http://localhost:8080/health   # health probe
```

On first launch, `/data/webmail.db` is created and any legacy
`/data/keyrings/*.json` files are auto-imported into the `personal_keyrings`
table.

## Configuration

Both defaults are loaded by the container from environment variables.
Uncomment in `docker-compose.yml` (or set via your orchestrator) to activate.

| Env var                   | Default | Purpose                                                 |
|---------------------------|---------|---------------------------------------------------------|
| `PORT`                    | `8080`  | Backend HTTP listen port                                |
| `DATA_DIR`                | `/data` | SQLite + keyring directory (must be on a persistent volume) |
| `SESSION_TTL_HOURS`       | `24`    | Idle session expiry                                     |
| `SESSION_SECRET`          | (random)| 32-byte AES-GCM key for credential-at-rest encryption   |
| `DEFAULT_IMAP_HOST`       | —       | Pre-fill IMAP host for users with custom domains        |
| `DEFAULT_IMAP_PORT`       | `993`   | Pre-fill IMAP port                                      |
| `DEFAULT_SMTP_HOST`       | —       | Pre-fill SMTP host                                      |
| `DEFAULT_SMTP_PORT`       | `587`   | Pre-fill SMTP port                                      |
| `DEFAULT_ALLOW_INSECURE_TLS` | `false` | Pre-fill "allow self-signed" checkbox (off by default) |

The public endpoint `GET /api/server-config` exposes the defaults so the login
page can pre-populate the advanced settings panel.

## Version metadata

`Version`, `BuildTime` and `CommitHash` are baked in at image build time and
shown in the startup log and the sidebar footer of the UI. Defaults are
`vdev` / `timeless` / `sha-unknown`; tag builds (`.github/workflows/container.yml`)
inject the real values via Docker `--build-arg`:

```bash
docker build \
  --build-arg VERSION=v1.2.3 \
  --build-arg BUILD_TIME=$(date -u +'%Y-%m-%dT%H:%M:%SZ') \
  --build-arg COMMIT_HASH=$(git rev-parse HEAD) \
  .
```

## Storage

Everything user-private lives in one SQLite file:

- `contact_keys` — per-user PGP public keys for contacts (email, fingerprint,
  key ID, ASCII-armored key).
- `personal_keyrings` — per-user cloud-synced private keyring (passphrase-
  encrypted private key + public key + metadata).

WAL mode is enabled (`journal_mode=WAL`, `busy_timeout=5000`); the
`-shm` / `-wal` siblings accompany the main file inside the same
`webmail-data` named volume.

## Development

### Backend
```bash
cd backend
go test ./...       # add tests here
go run ./cmd/server
```

### Frontend
```bash
cd frontend
npm install
npm run dev         # http://localhost:5173, proxies /api to :8080
npm run build
```

## Security notes

- Private keys are encrypted at rest with the user's passphrase; the server
  never sees the passphrase.
- Sessions are AES-GCM encrypted in memory; setting `SESSION_SECRET` is
  recommended for multi-instance deployments.
- TLS is mandatory by default (`allowInsecureTls = false`). Only enable
  self-signed certs via env when targeting a test environment.
- Requests hit the Go server directly (no nginx/proxy in front), so large PGP
  key imports of dozens of keys aren't rejected by a proxy size limit.

## License

MIT (or your preference — see `LICENSE` once added).
