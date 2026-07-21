# KUQuest API Server

Backend API for KUQuest Mobile and CMS, built with Elysia and Bun.

## Requirements

- Docker with Docker Compose

No local Bun or PostgreSQL installation is required. The application, migration
tooling, checks, and integration database all run in containers.

## Docker setup

```bash
cp .env.example .env
docker compose up --build
```

Compose waits for PostgreSQL to become healthy, runs all pending Drizzle
migrations once with the schema-owner role, and starts the API only after the
migration container exits successfully. The running API receives only the
restricted application-role database URL. PostgreSQL and API are the only
long-running services.

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

`NODE_ENV` is required and must be `development`, `test`, or `production`.
Development-only actor, diagnostics, and payment-simulation routes are enabled
only when it is explicitly set to `development`.

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

## First-party response contract

KUQuest-owned JSON endpoints such as `/health` and `/v1/wallet/*` always return
a discriminated response envelope. HTTP status codes remain truthful; clients
must check the HTTP status and can use `success` for type narrowing.

Successful response:

```json
{
  "success": true,
  "data": {},
  "error": null,
  "trace_id": "request-correlation-id"
}
```

Failed response:

```json
{
  "success": false,
  "data": null,
  "error": {
    "type": "https://api.kuquest.app/problems/validation-failed",
    "title": "Validation Failed",
    "status": 422,
    "code": "VALIDATION_FAILED",
    "detail": "The request did not match the required schema.",
    "issues": [
      { "path": "/amount", "message": "Expected an integer" }
    ]
  },
  "trace_id": "request-correlation-id"
}
```

`error.code` is the stable value for frontend branching. `error.detail` and
`error.issues[].message` are display-oriented and must not be parsed. The
`issues` array is always present and is empty for errors unrelated to request
fields.

Protocol-owned routes keep their native contracts: `/api/auth/*` is controlled
by Better Auth, `/openapi*` serves OpenAPI assets, and Xendit
webhook success acknowledgements remain empty HTTP 202 responses. KUQuest errors
raised while processing webhook requests still use the failure envelope.

## Database and migration commands

```bash
# Apply pending migrations with the dedicated migrator role
docker compose run --rm migrate

# Generate SQL after changing a Drizzle schema
docker compose build migrate
docker compose run --rm migrate bun run db:generate
```

PostgreSQL data is persisted in the `postgres_data` Docker volume.
The bootstrap script creates the fixed `kuquest_migrator` and `kuquest_app`
roles on a fresh volume. Keeping these names fixed makes the reviewed migration
grants predictable; configure their passwords and matching database URLs. It
also creates an isolated `kuquest_test` database. Changing bootstrap credentials
after a volume already exists does not rotate database passwords; recreate the
development volume or rotate the roles explicitly.

## Verification

Run every repository check, including PostgreSQL-backed integration tests, in
Docker with:

```bash
docker compose --profile test run --rm test
```

This runs linting, TypeScript validation, unit/integration tests, and the Bun
production build. The test container first migrates the isolated test database
as the migrator, then runs checks using the restricted app-role URL. Tests are
grouped by production boundary under `tests/`; a specific area can also be run
without installing Bun locally, for example:

```bash
docker compose --profile test run --rm test sh -euc \
  'DATABASE_URL="$MIGRATOR_TEST_DATABASE_URL" bun run db:migrate && DATABASE_URL="$TEST_DATABASE_URL" bun test tests/modules/auth'
```

To stop the stack, use `docker compose down`. To intentionally discard all
local database data and force the role bootstrap to run again, use
`docker compose down --volumes`.

## Project structure

```text
src/
├── config/                    # Typed environment configuration
├── database/
│   ├── client.ts              # Shared Drizzle/PostgreSQL client
│   └── schema/                # Database schemas grouped by concern
├── modules/
│   ├── auth/                  # Auth policy, sessions, CSRF, and request identity
│   ├── dev-test/              # Explicitly development-only test support
│   ├── health/                # Health route and response schema
│   ├── jobs/                  # Funded-job HTTP and persistence boundary
│   ├── money/                 # Wallet, ledger, policy, and webhook ingestion
│   └── payments/              # Top-up, payout, provider, and response schemas
├── plugins/                   # Cross-cutting Elysia plugins
├── app.ts                     # Application composition
└── index.ts                   # Runtime validation and HTTP startup
drizzle/                       # Versioned SQL migrations and metadata
tests/                         # Single test root mirroring production boundaries
```

The service uses a feature-first modular monolith. Business rules such as the
`@ku.th` email restriction stay inside their feature module, while database and
cross-cutting HTTP concerns remain reusable infrastructure. This keeps module
ownership clear without adding controller/repository abstractions before the
domain needs them.
