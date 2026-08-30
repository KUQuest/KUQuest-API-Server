# KUQuest API Server

Backend API for KUQuest Mobile and CMS, built with Elysia and Bun. 

## Requirements

- Bun: see `.bun-version`
- Docker with Docker Compose

## Run locally

Follow these steps from the repository root. The API uses Bun, PostgreSQL, and
local RustFS object storage.

### 1. Create the local environment file

```bash
cp .env.example .env
```

Set these values in `.env` before the API starts:

- `BETTER_AUTH_SECRET` and `ADMIN_BETTER_AUTH_SECRET`: separate values with at
  least 32 characters.
- `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`: local Google OAuth Web
  application credentials.
- `TERMS_URL`, `PRIVACY_URL`, `DATA_USAGE_URL`, and `CONTACT_US_URL`: URLs the
  mobile app can open.

Generate either Auth secret with:

```bash
openssl rand -base64 32
```

Do not commit `.env` or share its secrets.

### 2. Install dependencies

```bash
bun install --frozen-lockfile
```

### 3. Start local services

```bash
docker compose up -d
docker compose ps
```

Wait until `kuquest-postgres` and `kuquest-rustfs` are healthy. The
`rustfs-init` container creates the `kuquest` bucket once, then exits. That is
expected.

### 4. Apply database migrations

```bash
bun run db:migrate
```

Run this command after pulling a branch that changes `drizzle/`. It preserves
existing data and applies only migrations not recorded in the Drizzle ledger.

### 5. Start the API

```bash
bun run dev
```

The API prints this message when it is ready:

```text
KUQuest API running at http://localhost:5000
```

Keep this terminal open while you use the API.

### 6. Expose the test API with Cloudflare Tunnel

The Compose file includes a dedicated `cloudflared` service in the `tunnel`
profile. Set `CLOUDFLARE_TUNNEL_TOKEN` in the ignored `.env` file, then start
the tunnel:

```bash
docker compose --profile tunnel up -d cloudflared
docker compose logs -f cloudflared
```

The tunnel uses host networking because the test API runs on the host at
`http://localhost:5000`. The named tunnel's published application route in
Cloudflare must therefore use `http://localhost:5000` as its service URL. Use
the tunnel hostname from Cloudflare as the Xendit callback URL, with the API
callback path appended.

Stop the tunnel with:

```bash
docker compose --profile tunnel stop cloudflared
```

### 7. Verify local services

In a second terminal, run:

```bash
curl --fail http://localhost:5000/health
curl --fail http://localhost:5000/openapi/json
```

Open these URLs in a browser:

- Quest and finance test bench: `http://localhost:5000`
- OpenAPI: `http://localhost:5000/openapi`
- RustFS console: `http://localhost:9001`

The RustFS console uses `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` from
`.env`.

### 8. Configure Google sign-in

Create a Google OAuth 2.0 **Web application** client. Add this redirect URI:

```text
http://localhost:5000/api/auth/callback/google
```

If KUQuest Admin runs locally, also add `http://localhost:3000` as an
authorized JavaScript origin. Google sign-in accepts only a Student email that
ends exactly in `@ku.th`.

Do not open `public/index.html` with a `file://` URL. OAuth state and Session
cookies require the API origin.

### 9. Stop local services

```bash
docker compose stop
```

This keeps the PostgreSQL and RustFS volumes. Use `docker compose down` only
when you also want to remove the containers; it still keeps volumes unless you
add `--volumes`.

### Auth ID recovery

If Google sign-in logs `null value in column "id" of relation "auth_user"`, the
local database has an old Auth schema without ID defaults. First apply pending
migrations:

```bash
bun run db:migrate
```

Then confirm PostgreSQL now generates IDs automatically:

```bash
docker exec kuquest-postgres \
  psql -U kuquest -d kuquest -c \
  "SELECT table_name, column_default
   FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name IN ('auth_user', 'auth_admin', 'auth_session', 'auth_account', 'auth_verification')
     AND column_name = 'id'
   ORDER BY table_name;"
```

Each row must show `(gen_random_uuid())::text`. This fix does not delete
Students, Admins, Sessions, or Accounts.

`docker compose up -d` starts PostgreSQL and a local RustFS container that the
`.env.example` defaults already point at, so avatar and certificate image
uploads work without real `kubits.org` credentials. A one-shot `rustfs-init`
container creates the `kuquest` bucket the first time RustFS becomes healthy;
it exits immediately afterward, which is expected. The RustFS console is at
`http://localhost:9001`, signed in with `S3_ACCESS_KEY_ID` /
`S3_SECRET_ACCESS_KEY`.

`CMS_ORIGIN` must match the frontend origin that sends cookie-based auth
requests. The local default is `http://localhost:3000`.

## Authentication API

Better Auth is mounted at `/api/auth`. The main endpoints are:

- `POST /api/auth/sign-in/social` with `{ "provider": "google" }`
- `GET /api/auth/get-session`
- `POST /api/auth/sign-out`

Admin Better Auth is mounted separately at `/api/admin/auth` and supports login
only. Public Admin signup is disabled. Create the first Admin from an
operations environment with a local, ignored environment file:

```env
DATABASE_URL=postgresql://kuquest:kuquest-local-only@localhost:5432/kuquest
ADMIN_BETTER_AUTH_SECRET=replace-with-a-32-character-secret
ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=replace-with-a-compliant-password
ADMIN_FIRST_NAME=System
ADMIN_LAST_NAME=Administrator

# Required only for disposable staging bootstrap verification
STAGING_TEST_AUTH_PASSWORD=replace-with-a-compliant-test-password
```

Run the seed once with:

```bash
bun --env-file=.env.admin run db:seed-admin
```

The password must be 8–25 characters and include uppercase, lowercase, a
number, and an ASCII special character without whitespace. The seed lowercases
the email, refuses to modify an existing Admin, and never prints or stores the
plaintext password. Do not commit `.env.admin` or any real credentials.

The disposable staging bootstrap verification also reads
`ADMIN_PASSWORD` and `STAGING_TEST_AUTH_PASSWORD` from the caller environment.
Use the ignored `.env.admin` file when running that verification locally. The
staging workflow supplies both values from GitHub Actions secrets.

The Admin endpoints are:

- `POST /api/admin/auth/sign-in/email`
- `GET /api/admin/auth/get-session`
- `POST /api/admin/auth/sign-out`

Interactive OpenAPI documentation, including request examples, session cookie
security, response schemas, and OAuth errors, is available at
`http://localhost:5000/openapi`. The raw specification is available at
`http://localhost:5000/openapi/json`.

Google is the only enabled sign-in provider, and email/password authentication
is disabled. On first sign-in, Google profile data is saved in `auth_user` as
the Student's `id`, `first_name`, and `last_name`, with Better Auth's required
email and profile fields.

### Staging Student test account

Staging can expose a narrowly scoped Student test-login route for API
verification. It is disabled by default and requires both
`DEPLOYMENT_ENV=staging` and `STAGING_TEST_AUTH_ENABLED=true`; the application
refuses to start when the required test-account variables are missing or the
deployment environment is not staging.

Configure these as protected staging secrets, never in source control:

```env
DEPLOYMENT_ENV=staging
STAGING_TEST_AUTH_ENABLED=true
STAGING_TEST_AUTH_EMAIL=staging-test@ku.th
STAGING_TEST_AUTH_PASSWORD=replace-with-a-compliant-password
STAGING_TEST_AUTH_FIRST_NAME=Staging
STAGING_TEST_AUTH_LAST_NAME=Test Student
```

When staging test authentication is enabled, opening `http://localhost:5000`
automatically signs the browser in as the configured test Member through
`POST /api/staging/test-auth/sign-in/default`. The password is kept on the
server and is not sent to the browser. The page provides guided controls for
the Xendit Test Mode Top-up, Funding Reservation, Quest Escrow publication and
release, and an OpenAPI-driven console for all implemented Quest operations.

The default sign-in route is staging-only and returns `404` when the staging
test-auth flag is disabled. Do not enable it for a production deployment.

The email must end in `@ku.th`, and the password must be 8–25 ASCII characters
containing uppercase, lowercase, a number, and a special character. The first
valid login creates the configured Student if it does not exist, then returns
an ordinary Better Auth session cookie. Only that configured email can use the
route; it does not enable Student email/password login generally.

Use the dedicated staging route:

```bash
curl -i -c staging.cookies \
  -H 'content-type: application/json' \
  -d '{"email":"staging-test@ku.th","password":"replace-with-a-compliant-password"}' \
  https://kuquest-dev-api.kubits.org/api/staging/test-auth/sign-in/email

curl -b staging.cookies \
  https://kuquest-dev-api.kubits.org/api/v1/profile
```

The existing `db:seed-admin` workflow remains the path for creating an Admin.
This Student route is separate because an Admin session cannot access
Student-owned endpoints.

### Local finance test routes

For local finance verification, enable the guarded test route together with the
staging Student test account. It requires `NODE_ENV=development` and an
Xendit Development API key. The recipient is created as a second local Member
when the transfer test runs.

```env
LOCAL_FINANCE_TEST_ENABLED=true
LOCAL_FINANCE_TEST_RECIPIENT_EMAIL=finance-test-recipient@ku.th
LOCAL_FINANCE_TEST_RECIPIENT_FIRST_NAME=Finance
LOCAL_FINANCE_TEST_RECIPIENT_LAST_NAME=Recipient
```

After signing in with the staging test route, run these local-only checks:

```bash
curl -b staging.cookies \
  http://localhost:5000/api/local/test/wallet

curl -b staging.cookies -H 'content-type: application/json' \
  -X POST http://localhost:5000/api/local/test/payment \
  -d '{"creditSatang":100,"simulate":true}'

curl -b staging.cookies -H 'content-type: application/json' \
  -X POST http://localhost:5000/api/local/test/transfer \
  -d '{"amountSatang":100}'
```

The Payment route creates and simulates a real Xendit Test Mode Payment
Request. It first waits for the Xendit callback. If the callback is not
delivered, it uses the existing Provider reconciliation path and reports
`reconciliationUsed: true`. The Transfer route performs a real `Funding
Reservation` followed by a sealed `Ledger Transaction` from the test
Student's `Spending Balance` to the recipient Member's `Earnings Balance`.
The browser page displays the current Wallet compartments and renders the QR
from the Xendit response. All browser money inputs and displayed amounts use
Baht. The raw finance API keeps integer Satang at its boundary. It redacts the
QR payload from debug messages.

The Payout panel calls the normal Payout Quote and Payout submission APIs. It
shows the maximum debit and masked active Payout Destination. The submitted
Payout remains `PENDING_ADMIN_APPROVAL` until an Admin approves it; the browser
page does not bypass that control or call the Payout Provider directly.

These local finance routes return 404 for any other user and are disabled
unless the local flags are valid.

Staging CD starts only after a successful Backend CI run for a push to
`develop`. Opening a pull request runs CI but does not deploy; merge the pull
request into `develop` to trigger staging deployment.
Changing protected staging secrets alone does not start a deployment; merge a
new `develop` change after rotating them.
This deployment trigger verifies the rotated staging test-auth and Admin-seed flags.
This trigger also verifies the staging Admin seed uses the deployed image.
This trigger verifies the staging test-auth enablement value is loaded exactly.
This trigger runs the final staging runtime configuration check.
This trigger captures the final non-secret runtime flag diagnostics.

## Database commands

```bash
bun run db:generate  # generate a SQL migration after schema changes
bun run db:check     # verify schema sync and inherited migration history
bun run db:migrate   # apply migrations and re-encrypt legacy Payout secrets
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

A pull request targeting `develop` runs CI only. Staging CD starts after that
pull request is merged and the resulting push to `develop` passes Backend CI.

CD publishes the PostgreSQL 17 client as a commit-tagged image in the same GHCR
package as the API, so the staging host does not need direct Docker Hub access.

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
production build, including the local migration-artifact contract.

Some tests read and write real tables, so PostgreSQL must be running and
migrated before `bun test` or `bun run check`:

```bash
docker compose up -d postgres
bun run db:migrate
```

They connect through `DATABASE_URL`, the same variable the application uses, and
clean up the rows they create. Point `DATABASE_URL` at a throwaway database to
keep development data out of their way. CI does exactly that, running the suite
against a `kuquest_test` database of its own.

Tests are grouped by production boundary under `tests/` so a specific area can
also be run independently, for example:

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
│   ├── certificate/           # Student profile certificates
│   ├── health/                # Health route and response schema
│   ├── onboarding/            # First sign-in details and academic options
│   └── profile/               # Student profile fields and avatar
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
domain needs them. nice one.
