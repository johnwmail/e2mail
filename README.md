# e2mail

Self-hosted, end-to-end encrypted webmail client. Speaks IMAP/SMTP to any mail
provider, stores PGP key material in a single SQLite file, and runs as a pair
of Docker containers behind nginx.

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
┌──────────────┐      HTTP      ┌─────────────────────────────┐
│  Browser UI  │ ◀────────────▶ │  nginx (frontend container)  │
│  React + Vite│   /api/*       │  reverse-proxies to backend  │
└──────────────┘                └──────────────┬──────────────┘
                                              │
                                              ▼
                                ┌─────────────────────────────┐
                                │  Go backend (chi)            │
                                │  HTTP API :8080              │
                                │  IMAP client pool + IDLE     │
                                │  SMTP sender                 │
                                │  Sessions (in-memory, AES)   │
                                │  + SQLite storage            │
                                └─────────────────────────────┘
                                              │
                                              ▼
                                /data/webmail.db  (named volume)
```

| Service   | Tech                              | Port (host) |
|-----------|-----------------------------------|-------------|
| backend   | Go 1.25 + chi + modernc.org/sqlite| `8080`      |
| frontend  | React 18 + Vite + Tailwind, nginx | `8000`      |

## Quick start

```bash
# Clone
git clone <repo-url> e2mail
cd e2mail

# Build & run
docker compose up -d --build

# Open
open http://localhost:8000      # webmail UI
curl http://localhost:8080/health   # backend probe
```

On first launch, `/data/webmail.db` is created and any legacy
`/data/keyrings/*.json` files are auto-imported into the `personal_keyrings`
table.

## Configuration

Both defaults are loaded by the backend container from environment variables.
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

## Deployment

The full deploy workflow (rsync → remote → `docker compose build / up`) lives
in [AGENTS.md](./AGENTS.md). A short version:

```bash
rsync -avz --delete \
  --exclude='.git' --exclude='node_modules' --exclude='dist' \
  -e ssh ./ exedev@debian.exe.xyz:~/e2mail/
ssh exedev@debian.exe.xyz 'cd ~/e2mail && docker compose build --no-cache && docker compose up -d'
```

## Security notes

- Private keys are encrypted at rest with the user's passphrase; the server
  never sees the passphrase.
- Sessions are AES-GCM encrypted in memory; setting `SESSION_SECRET` is
  recommended for multi-instance deployments.
- TLS is mandatory by default (`allowInsecureTls = false`). Only enable
  self-signed certs via env when targeting a test environment.
- The nginx entrypoint sets `client_max_body_size 50M` so bulk PGP key
  imports of dozens of keys aren't rejected.

## License

MIT (or your preference — see `LICENSE` once added).
