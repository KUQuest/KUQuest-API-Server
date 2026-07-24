# KUQuest API Server

Backend API for KUQuest Mobile and CMS, built with Elysia and Bun.

## Requirements

- Bun: see `.bun-version`
- Docker with Docker Compose

## Local setup

```bash
cp .env.example .env
bun install --frozen-lockfile
docker compose up -d postgres
bun run db:migrate
bun run dev
```

Open `http://localhost:5000` in a browser to use the built-in Google login,
session inspection, and sign-out test page.

Do not open `public/index.html` directly with a `file://` URL. OAuth state and
session cookies require the page to be served by the API origin.

Generate a secure Better Auth secret and put the result in
`BETTER_AUTH_SECRET`:

```bash
openssl rand -base64 32
```

Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` to credentials from a Google
Cloud OAuth 2.0 Web application. Add this authorized redirect URI in Google
Cloud for local development:

```text
http://localhost:5000/api/auth/callback/google
```

The OAuth client must use the **Web application** type. If the CMS runs locally,
add `http://localhost:3000` as an authorized JavaScript origin as well.

`CMS_ORIGIN` must match the frontend origin that sends cookie-based auth
requests. The local default is `http://localhost:3000`.

## Authentication API

Better Auth is mounted at `/api/auth`. The main endpoints are:

- `POST /api/auth/sign-in/social` with `{ "provider": "google" }`
- `GET /api/auth/get-session`
- `POST /api/auth/sign-out`

Interactive OpenAPI documentation, including request examples, session cookie
security, response schemas, and OAuth errors, is available at
`http://localhost:5000/openapi`. The raw specification is available at
`http://localhost:5000/openapi/json`.

Google is the only enabled sign-in provider, and the Google account must have an
email address ending exactly in `@ku.th`. Email/password authentication is
disabled. On first sign-in, Google profile data is saved in the `user` table as
`user_id` (primary key), `first_name`, and `last_name`, along with Better Auth's
required email and profile fields.

## Database commands

```bash
bun run db:generate  # generate a SQL migration after schema changes
bun run db:check     # verify schema sync and inherited migration history
bun run db:migrate   # apply pending migrations
bun run db:studio    # open Drizzle Studio
```

PostgreSQL data is persisted in the `postgres_data` Docker volume.

### Database-change workflow

Use this sequence for every Drizzle schema change:

1. Edit the schema under `src/database/schema/`.
2. Run `bun run db:generate`.
3. Inspect the generated SQL under `drizzle/` and its metadata under
   `drizzle/meta/`.
4. Run `bun run db:check`.
5. Commit the schema, generated SQL, and Drizzle metadata together.

`db:check` runs the same generation contract used by CI. It fails when
generation produces tracked or untracked artifacts that were not present
before the check. In CI it also compares against the pull-request target or
pre-push revision.

Migration SQL and journal entries already inherited from `develop` are
immutable: do not edit, rename, reorder, or delete them. Correct an applied or
merged migration with a new forward migration. Drizzle metadata may advance
when that new migration is generated.

Database changes must follow expand-and-contract compatibility:

- Expand first with backward-compatible tables, columns, and indexes.
- Deploy code that works with both the old and expanded schema.
- Contract obsolete structures in a later migration after no deployed code
  depends on them.

There are no automatic down migrations. Fix an applied defect with a new
forward migration and restore from a verified backup only when an operator
deliberately chooses database recovery.

### CI migration validation

Backend CI:

- runs `db:check` with the correct pull-request or pre-push comparison base;
- keeps linting, type validation, tests, and the production build required;
- builds the production image;
- applies that image's complete committed migration chain to PostgreSQL 17;
- runs the same image migration command again against the current database;
- starts the image and checks `/health`.

This proves that committed artifacts are coherent, executable, repeatable, and
present in the deployed image. It cannot prove that an arbitrary data
transformation is correct for the business. Data migrations still need
meaningful fixtures, assertions, and human SQL review.

### Staging migration and recovery

After successful CI on `develop`, staging CD records the running API image,
pulls the validated image, and then performs:

1. a compressed PostgreSQL 17 logical backup through the protected
   `DATABASE_URL`;
2. non-empty-file and `pg_restore --list` validation;
3. rotation to the two newest valid backups;
4. `bun run db:migrate` in a removable one-off instance of the Compose `api`
   service;
5. API replacement and the existing Compose readiness check.

The current API keeps serving during backup and migration. Backup or migration
failure stops before replacement. If the new API fails readiness, CD restores
the exact previous image and leaves successfully applied compatible migrations
in place. An initial deployment with no previous image remains failed if
readiness fails.

Backups are stored in `/opt/backend/backups` on the staging host with restrictive
permissions. Credentials stay in `/opt/backend/.env` and are not printed.

### One-time staging bootstrap

The currently empty staging database needs one deliberate bootstrap before
recurring migration CD is enabled. This command is never called by CI or
staging CD:

```bash
APP_IMAGE=ghcr.io/kuquest/kuquest-api-server:<validated-sha> \
STAGING_DIR=/opt/backend \
ENV_FILE=/opt/backend/.env \
BACKUP_DIR=/opt/backend/backups \
STAGING_NETWORK=kuquest-staging_default \
bash scripts/staging-operations.sh bootstrap
```

The operation pulls the migration-capable image and creates and validates a
final backup before prompting for the exact text:

```text
RESET staging public schema
```

Only the target database's `public` schema is dropped and recreated.
PostgreSQL roles, the server instance, and unrelated databases are untouched.
The image then applies the complete committed chain and verifies the
authentication tables and Drizzle journal. Any post-backup failure prints the
recovery backup path. This is not a routine deployment or recovery command.

Exercise the complete bootstrap safely against disposable PostgreSQL 17 with:

```bash
bash scripts/verify-staging-bootstrap.sh
```

This opt-in verification builds the production image, uses an isolated Docker
network and database, runs the real typed-confirmation/reset/migration path,
and validates the resulting custom-format backup with `pg_restore --list`. It
is deliberately not part of recurring CI or staging CD.

## Verification

Run every repository check with:

```bash
bun run check
```

This runs linting, TypeScript validation, unit/integration tests, and the Bun
production build, including the local migration-artifact contract. Tests are
grouped by production boundary under `tests/` so a specific area can also be
run independently, for example:

```bash
bun test tests/modules/auth
bun test tests/database
```

## Project structure

```text
src/
├── config/                    # Typed environment configuration
├── database/
│   ├── client.ts              # Shared Drizzle/PostgreSQL client
│   └── schema/                # Database schemas grouped by concern
├── modules/
│   ├── auth/                  # Auth config, policy, routes, and plugin
│   └── health/                # Health route and response schema
├── plugins/                   # Cross-cutting Elysia plugins
├── app.ts                     # Application composition
└── index.ts                   # Runtime validation and HTTP startup
public/                        # Browser-based auth test page
drizzle/                       # Versioned SQL migrations and metadata
tests/                         # Tests mirroring production boundaries
```

The service uses a feature-first modular monolith. Business rules such as the
`@ku.th` email restriction stay inside their feature module, while database and
cross-cutting HTTP concerns remain reusable infrastructure. This keeps module
ownership clear without adding controller/repository abstractions before the
domain needs them.
