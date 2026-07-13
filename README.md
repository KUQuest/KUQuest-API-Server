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

Google is the only enabled sign-in provider, and the Google account must have an
email address ending exactly in `@ku.th`. Email/password authentication is
disabled. On first sign-in, Google profile data is saved in the `user` table as
`user_id` (primary key), `first_name`, and `last_name`, along with Better Auth's
required email and profile fields.

## Database commands

```bash
bun run db:generate  # generate a SQL migration after schema changes
bun run db:migrate   # apply pending migrations
bun run db:studio    # open Drizzle Studio
```

PostgreSQL data is persisted in the `postgres_data` Docker volume.

## Verification

Run every repository check with:

```bash
bun run check
```

This runs linting, TypeScript validation, unit/integration tests, and the Bun
production build. Tests are grouped by production boundary under `tests/` so a
specific area can also be run independently, for example:

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
