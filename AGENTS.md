# AGENTS.md

## Project
Self-hosted end-to-end encrypted webmail client.
- `backend/` — Go 1.22 + chi, IMAP/SMTP proxy + HTTP API on `:8080`.
- `frontend/` — React 18 + Vite + Tailwind, nginx-served on `:8000`.
- `docker-compose.yml` — orchestrates both services; named volume `webmail-data` persists PGP keyrings.

## Remote target
```
host:   exedev@debian.exe.xyz
path:   ~/e2mail/
```

Both Dockerfiles are self-contained (multi-stage builds), so the remote only needs Docker Engine + the compose plugin. No local toolchain required on the remote.

## Deploy workflow

### 1. Sync source from local → remote
From the repo root, excluding build artefacts and VCS noise:

```bash
rsync -avz --delete \
  --exclude='.git' \
  --exclude='node_modules' \
  --exclude='dist' \
  --exclude='**/*.log' \
  --exclude='.DS_Store' \
  -e ssh \
  ./ exedev@debian.exe.xyz:~/e2mail/
```

`--delete` mirrors the tree so removed files don't linger. Add `--dry-run` first if you want to preview.

### 2. Build, test, run on remote
Open an interactive shell:

```bash
ssh exedev@debian.exe.xyz 'cd ~/e2mail && exec $SHELL'
```

Then inside the remote:

```bash
# build images (no cache if you want a clean rebuild)
docker compose build              # incremental
docker compose build --no-cache   # clean rebuild

# run
docker compose up -d              # detached
docker compose ps                 # confirm both containers healthy

# inspect
docker compose logs -f --tail=200 backend
docker compose logs -f --tail=200 frontend
curl -fsS http://localhost:8080/health   # backend health probe
curl -fsS http://localhost:8000/         # frontend serving
```

### 3. Tear down / restart
```bash
docker compose restart backend            # pick up code changes after rebuild
docker compose down                       # stop + remove containers (keeps volume)
docker compose down --volumes             # nuclear: also wipe webmail-data
```

## One-shot: build + (re)start a single service
After editing backend code:
```bash
rsync -avz --delete --exclude='.git' --exclude='node_modules' --exclude='dist' \
  -e ssh ./ exedev@debian.exe.xyz:~/e2mail/ && \
ssh exedev@debian.exe.xyz 'cd ~/e2mail && \
  docker compose build backend && \
  docker compose up -d backend'
```

After editing frontend code, swap `backend` → `frontend` in the same one-liner.

## Notes
- **Responsive UI**: every feature (login, 2FA setup/verify, PGP key management, mail list/view, composer, modals) must work on both mobile and desktop browsers — use responsive Tailwind classes (`lg:`, `md:`, `sm:` breakpoints), ensure touch-friendly tap targets, and never rely on hover-only interactions. Verify on a mobile viewport before deploying.
- Backend listens on host port **8080**, frontend on **8000** (see `docker-compose.yml`).
- Backend writes user PGP keyrings to `/data` → named volume `webmail-data`. Don't bind-mount unless you have a reason; the named volume survives `docker compose down`.
- `frontend/default.conf.template` is rendered by the official `nginx` image's entrypoint using `BACKEND_HOST`/`BACKEND_PORT` env vars from compose — don't hardcode the upstream.
- SSE on `/api/events` needs `proxy_buffering off` (already set in the nginx template); don't reintroduce a caching proxy in front of the backend without preserving that.
- Backend tests: none committed yet. If added under `backend/`, run `go test ./...` locally before syncing — the remote Dockerfile doesn't run tests during image build.
