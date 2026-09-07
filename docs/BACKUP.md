# SQLite automatic backup (`DB_BACKUP`)

Status: implemented.

## Goal

Take a consistent snapshot of `$DATA_DIR/e2Mail.db` on a calendar period so a
corrupt or accidentally truncated live DB can be replaced without rebuilding
accounts. Mail bodies are **not** in SQLite (IMAP is proxied live); a restore
only recovers e2Mail state (credentials envelope, accounts, PGP keyrings, 2FA,
contacts, prefs).

## Env

| Value | Default | Period key (UTC) | Retention |
|-------|---------|------------------|-----------|
| `DISABLE` | yes | — | — |
| `DAILY` | | `YYYY-MM-DD` | 7 |
| `WEEKLY` | | ISO week `YYYY-Www` | 4 |
| `MONTHLY` | | `YYYY-MM` | 12 |

Case-insensitive. Unknown values log a warning and fall back to `DISABLE`.

Set in `.env` / compose:

```bash
DB_BACKUP=DAILY
```

Files land on the **same** persistent volume as the live DB:

```
$DATA_DIR/backups/e2Mail.daily.2026-09-07.db
$DATA_DIR/backups/e2Mail.weekly.2026-W37.db
$DATA_DIR/backups/e2Mail.monthly.2026-09.db
```

## Behaviour

- After store init (and legacy keyring migration), a goroutine runs immediately
  then every hour.
- If the file for the current period already exists, the tick is a no-op.
- Snapshot uses SQLite `VACUUM INTO` (WAL-safe consistent copy) then rename
  into place.
- Older files matching `e2Mail.<schedule>.*` are pruned to the retention count.

Backups are ciphertext copies of the live DB (same `e1:` / hashes). They are
**not** a substitute for an off-volume tarball before a schema upgrade — they
live inside `DATA_DIR`. For upgrade-day copies, see `docs/ENCRYPTION.md` §6.

## Restore

Stop the container, replace the live file, start again:

```bash
docker compose stop e2mail
# volume name may be <project>_data — check with `docker volume ls`
docker run --rm -v e2mail_data:/data alpine sh -c \
  'cp /data/backups/e2Mail.daily.2026-09-07.db /data/e2Mail.db'
docker compose start e2mail
```

Do not copy `-wal` / `-shm` from a `VACUUM INTO` snapshot; the backup is a
standalone database file.

## Tests

`backend/internal/config/config_test.go` (parse / load) and
`backend/internal/storage/backup_test.go` (period keys, round-trip, skip-if-due,
retention, scheduler start/stop).
