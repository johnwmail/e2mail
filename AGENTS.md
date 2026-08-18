# AGENTS.md

## Project
Self-hosted end-to-end encrypted webmail client.
- `backend/` — Go 1.22 + chi, IMAP/SMTP proxy + HTTP API on `:8080`.
- `frontend/` — React 18 + Vite + Tailwind, nginx-served on `:8000`.
- `docker-compose.yml` — orchestrates both services; named volume `webmail-data` persists PGP keyrings.

## Notes
- **Responsive UI**: every feature (login, 2FA setup/verify, PGP key management, mail list/view, composer, modals) must work on both mobile and desktop browsers — use responsive Tailwind classes (`lg:`, `md:`, `sm:` breakpoints), ensure touch-friendly tap targets, and never rely on hover-only interactions. Verify on a mobile viewport before deploying.
- Backend listens on host port **8080**, frontend on **8000** (see `docker-compose.yml`).
- Backend writes user PGP keyrings to `/data` → named volume `webmail-data`. Don't bind-mount unless you have a reason; the named volume survives `docker compose down`.
- `frontend/default.conf.template` is rendered by the official `nginx` image's entrypoint using `BACKEND_HOST`/`BACKEND_PORT` env vars from compose — don't hardcode the upstream.
- SSE on `/api/events` needs `proxy_buffering off` (already set in the nginx template); don't reintroduce a caching proxy in front of the backend without preserving that.
- Backend tests: none committed yet. If added under `backend/`, run `go test ./...` locally before committing.
