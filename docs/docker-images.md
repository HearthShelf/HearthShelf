# Docker images: slim vs all-in-one

HearthShelf ships as two images built from one `Dockerfile` (multi-target).

| | slim | all-in-one (aio) |
| --- | --- | --- |
| Contains | HearthShelf SPA + backend | HearthShelf + a bundled AudiobookShelf |
| ABS | yours, external (`ABS_SERVER_URL`) | bundled in-container, auto-provisioned |
| `HS_MODE` | `slim` (default) | `aio` |
| Setup | you already run ABS | one container, HearthShelf sets ABS up |
| Compose | `docker-compose.yml` | `docker-compose.aio.yml` |
| Build | `--target slim` | `--target aio` |

Both serve the same SPA and the same QuestGiver backend; only the final image
stage and entrypoint differ. See `Dockerfile`.

## slim

The original image. HearthShelf is a face over an ABS server you already run.
Point it at that server and sign in with your existing ABS account.

```bash
docker build --target slim -t hearthshelf:slim .
docker compose up -d        # uses docker-compose.yml (HearthShelf + your ABS on an internal network)
```

`ABS_SERVER_URL` must reach your ABS server. The onboarding flow assumes ABS is
already set up; it offers (but does not assume) connecting to
app.hearthshelf.com.

## all-in-one (aio)

One container runs nginx, the bundled ABS server, and the HearthShelf backend.
On first boot HearthShelf:

1. waits for the bundled ABS to come up,
2. creates the ABS root user (generated password),
3. logs in to mint an admin token it reuses,
4. creates a default `Audiobooks` library pointed at `/audiobooks`,
5. records this so it runs exactly once (the `provisioning` table).

The admin then sees only HearthShelf's onboarding wizard, which **defaults to
connecting to app.hearthshelf.com** (the most frictionless path) and reveals the
generated root credentials once, with a prompt to change the password.

```bash
docker build --target aio -t hearthshelf:aio .
PUBLIC_URL=https://books.example.com docker compose -f docker-compose.aio.yml up -d
```

Mount your audiobooks at `/audiobooks`; ABS config and metadata persist on the
`abs-config` / `abs-metadata` volumes, HearthShelf's own state on
`hearthshelf-data`.

### Supervision

`docker-entrypoint-aio.sh` starts all three processes (tini is PID 1) and exits
the container if any one dies, so Docker's restart policy recycles the box. ABS
listens on `127.0.0.1:13378` and the HearthShelf backend on `127.0.0.1:8080`;
nginx on port 80 is the only ingress.

### Restoring an existing ABS volume into aio

If you mount an `abs-config` volume that already has a root user, HearthShelf
detects ABS is initialised, records that, and skips provisioning - it cannot
recover your existing root password, so sign in with your existing ABS account.
