# AGENTS.md

## Project
Self-hosted end-to-end encrypted e2Mail client.
- `backend/` — Go 1.26 + chi, IMAP/SMTP proxy + HTTP API, serves the embedded frontend.
- `frontend/` — React 19 + Vite 8 + Tailwind 4; built by the Docker image and `go:embed` into the backend binary (see `backend/web`).
- `Dockerfile` — single multi-stage image (node build → go build → alpine runtime); `docker-compose.yml` runs one service.

## Notes
- **Responsive UI**: every feature (login, 2FA setup/verify, PGP key management, mail list/view, composer, modals) must work on both mobile and desktop browsers — use responsive Tailwind classes (`lg:`, `md:`, `sm:` breakpoints), ensure touch-friendly tap targets, and never rely on hover-only interactions. Verify on a mobile viewport before deploying.
- Service listens on host port **8080** (see `docker-compose.yml`). Frontend is served by the backend itself on the same port; `/api/*` routes take precedence, everything else falls back to the SPA (`internal/api/static.go`).
- Backend writes user PGP keyrings to `/data` → named volume `webmail-data`. Don't bind-mount unless you have a reason; the named volume survives `docker compose down`.
- `Version`/`BuildTime`/`CommitHash` defaults are `vdev`/`timeless`/`sha-unknown`, overridden via `-ldflags -X` (backend) and `VITE_APP_*` build env (frontend) — see the Dockerfile ARGs and `.github/workflows/container.yml`.
- Tests: backend `go test ./...` (add `-race` for CI), frontend `npm run test` (Vitest + Testing Library). GitHub Actions runs both on push/PR to `main` (see `.github/workflows/test.yml`); run them locally before committing.
