# KUQuest API Server Setup & Operations Guide

This guide contains everything required to configure, run, migrate, test, and deploy the KUQuest API Server.

---

## 📋 Prerequisites

- **Bun**: Runtime and package manager (see `.bun-version` or install via `curl -fsSL https://bun.sh/install | bash`)
- **Docker & Docker Compose**: For local PostgreSQL, RustFS S3 storage, and Cloudflare Tunnel

---

## 🚀 Quick Start (Local Development)

Follow these steps from the repository root to start all local services and the API.

### 1. Create Environment Configuration

```bash
cp .env.example .env
```

Key environment variables in `.env`:

- `DATABASE_URL`: Connection string for PostgreSQL (default: `postgresql://kuquest:kuquest-local-only@localhost:5432/kuquest`)
- `BETTER_AUTH_SECRET`: Secret key (min 32 characters) for Student mobile session authentication
- `ADMIN_BETTER_AUTH_SECRET`: Secret key (min 32 characters) for Admin web session authentication
- `GOOGLE_CLIENT_ID` & `GOOGLE_CLIENT_SECRET`: OAuth 2.0 Web Application credentials for `@ku.th` student sign-in
- `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`: Object storage configuration (points to local RustFS container)

### HTTPS Candidate Team invites

The API serves the browser fallback at `/invite/team` and the Android/iOS
association files at `/.well-known/assetlinks.json` and
`/.well-known/apple-app-site-association`. Set both association variables on
the deployment before expecting the operating system to open the app directly:

- `ANDROID_APP_LINK_TARGETS`: JSON array of `{ "packageName": string,
"sha256CertFingerprints": string[] }` entries. Include every app package
  that should claim this host and each actual signing-certificate SHA-256
  fingerprint used to distribute it.
- `IOS_APP_LINK_APP_IDS`: comma-separated Apple App IDs in
  `TEAM_ID.bundle.identifier` form for the signed app variants.

The staging deployment reads both values from GitHub Environment `staging`
variables with the same names. The current development client uses package
`com.kuquest.mobile.debug` and this local debug-certificate SHA-256:
`FA:C6:17:45:DC:09:03:78:6F:B9:ED:E6:2A:96:2B:39:9F:73:48:F0:BB:6F:89:9B:83:32:66:75:91:03:3B:9C`.
This fingerprint only verifies builds signed with that exact debug key; it
does not cover the staging or production release packages.
Do not use sample, debug, or placeholder fingerprints for a distributed
Staging or Production app. The API returns `503` for an association document
until its complete, valid configuration is present. The invite page remains
available and lets a recipient copy the temporary Join Code.

Generate 32-character secrets with:

```bash
openssl rand -base64 32
```

### 2. Install Dependencies

```bash
bun install --frozen-lockfile
```

### 3. Start Local Infrastructure

```bash
docker compose up -d
docker compose ps
```

Wait until `kuquest-postgres` and `kuquest-rustfs` become healthy. The `rustfs-init` container will create the `kuquest` storage bucket once and exit cleanly.

### 4. Apply Database Migrations

```bash
bun run db:migrate
```

_Tip: Always run `bun run db:migrate` after pulling changes that touch `drizzle/`._

### 5. Start the Development Server

```bash
bun run dev
```

The API will start with auto-reload:

```text
KUQuest API running at http://localhost:5000
```

---

## 🔍 Verification & Health Checks

In another terminal, verify the server status:

```bash
curl --fail http://localhost:5000/health
curl --fail http://localhost:5000/openapi/json
```

Key Local URLs:

- **API Test Bench & Simulation UI**: [http://localhost:5000](http://localhost:5000)
- **Interactive OpenAPI Docs**: [http://localhost:5000/openapi](http://localhost:5000/openapi)
- **RustFS S3 Console**: [http://localhost:9001](http://localhost:9001) _(login with credentials from `.env`)_
- **Drizzle Studio**: `bun run db:studio` -> [https://local.drizzle.studio](https://local.drizzle.studio)

### Request and WebSocket logs

The Server writes one JSON `http.request` line for each completed HTTP request. Use the
`X-Request-ID` response header to find that line. Cross-origin Admin web requests can
read this header. The log includes the method, route template, status, duration, and
safe error code when available. A request that never reaches the Server has no Server
request ID.

WebSocket upgrades that fail have an `http.request` line. Successful connections
write `ws.open`, `ws.subscribed`, frame-type events, and `ws.close` with a close code.
Browser WebSocket clients cannot read upgrade response headers. To correlate a
connection from the frontend, generate a UUID for that connection and append
`?traceId=<uuid>` to its WebSocket URL. Search for `clientTraceId` in Server logs;
the Server also assigns its own `requestId`. Invalid trace IDs are ignored. A
`ws.send` line means the Server called send, not that the frontend received a frame.

These request and WebSocket log entries omit query strings, request and frame
bodies, Session tokens, Member identifiers, and Message text. Do not put
credentials in WebSocket URLs. In staging, read container output with
`docker compose logs --since 10m api`; configure log rotation and retention
on the deployment host before keeping production logs.

---

## 🧪 Testing & Code Quality

Run the complete validation pipeline (Linters, Typecheck, Test Suite, and Production Build):

```bash
bun run check
```

Run specific test subsets:

```bash
bun test                      # Run all tests
bun test tests/modules/auth   # Run auth module tests
bun test tests/database       # Run database integration tests
bun test --watch              # Watch mode
```

---

## 🗄️ Database Management & Workflow

### Drizzle CLI Commands

```bash
bun run db:generate           # Generate new SQL migration after editing schema in src/database/schema/
bun run db:check              # Verify migration journal and schema synchronization (used by CI)
bun run db:migrate            # Apply pending migrations to PostgreSQL
bun run db:studio             # Launch Drizzle Studio web interface
bun run db:reset-local        # Reset local database (caution: wipes data)
```

### Demo seed flow

```bash
# Apply reference data, then run Tags → Admin → Members → funded Quests.
# Configure Admin credentials, STAGING_TEST_AUTH_PASSWORD, and S3 storage first.
bun run db:migrate
bun --env-file=.env.admin run db:seed-staging
bun --env-file=.env.admin run db:verify-staging-seed
```

The dedicated Member step creates exactly 10 demo Members with complete Academic
Registration, Profile pictures, Portfolio items, Certificates, and Work Experience.
The Quest step creates one v2 Published Quest per Member with an illustrative
picture and a start date 30–120 days after the first run. Due dates are seven days
later. Each new Wallet has ฿1,000 in Spending Balance after funding its Quest.

Mobile debug login lists these same 10 Members by name. All share the configured
`STAGING_TEST_AUTH_PASSWORD`. Login does not create Members. Normal Google login
remains the Member login method outside staging debug use.

For a focused rerun, use `db:seed-demo-users` or `db:seed-demo-quests` in that order.
Reruns keep Member and Quest identities, do not add starter funds again, and preserve
Quest participation and terminal decisions. They do not restore money spent later.
The old generic frontend, image, staging-test-user, and finance-test seed commands are removed.
The staging flow does not create extra finance Members, completed Quests, Reviews, Dispute Cases,
Payout Destinations, or pending Payouts.

### Local Admin frontend demo seed

Run this only against a local development database. Configure Admin credentials,
`STAGING_TEST_AUTH_PASSWORD`, `PAYOUT_DESTINATION_ENCRYPTION_KEY`, and S3 storage in
`.env.admin`. If `XENDIT_SECRET_KEY` is set, it must be an Xendit Development key.

```bash
bun --env-file=.env.admin run db:migrate
bun --env-file=.env.admin run db:seed-demo-frontend
```

The one-command seed creates one Admin, 10 Student Members, one Staff Member, and
one Lecturer Member. It prepares 50 v2 Quests: five in each non-open Quest State
and 20 in `QUEST_OPEN`. It also prepares five of each `Report Case`, `Conduct
Report`, and `Dispute Case` status, five Top-ups, five Payouts, and all four Wallet
statuses. It uses the real Quest, Wallet, and Admin decision services. Reruns keep
stable records and preserve Admin decisions.

### Migration Guidelines

1. Edit schema files under `src/database/schema/`.
2. Run `bun run db:generate`.
3. Inspect the generated SQL in `drizzle/` and journal in `drizzle/meta/`.
4. Run `bun run db:check` to ensure parity.
5. Commit schema, SQL files, and metadata together.

---

## 🛡️ Authentication & Admin Setup

### 1. Google OAuth (Student App)

- Configure a Google OAuth 2.0 Web Client with redirect URI:
  ```text
  http://localhost:5000/api/auth/callback/google
  ```
- Only Student accounts ending in `@ku.th` are permitted to sign in.

### 2. Admin Credentials (Admin Web App)

Create `.env.admin` locally (ignored by Git):

```env
DATABASE_URL=postgresql://kuquest:kuquest-local-only@localhost:5432/kuquest
ADMIN_BETTER_AUTH_SECRET=replace-with-a-32-character-secret
ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=YourPassword123!
ADMIN_FIRST_NAME=System
ADMIN_LAST_NAME=Administrator
```

The standalone seed script is the supported first-Admin bootstrap. It requires
the six values shown above. It exits with status 1 and makes no changes when
any Admin already exists, including an Admin with a different email.
Credential creation goes through Better Auth, which stores a password hash in
`auth_account`; the plaintext password is never stored or printed. Keep
`.env.admin` outside source control. Run the standalone command only in a
controlled deployment process.

Run the seed script:

```bash
bun --env-file=.env.admin run db:seed-admin
```

For UAT, `Backend UAT CD` runs the first-Admin seed after each successful
`deploy` operation. It skips the seed on `rollback`. Configure these GitHub
environment secrets for `uat`: `ADMIN_EMAIL`, `ADMIN_PASSWORD`,
`ADMIN_FIRST_NAME`, and `ADMIN_LAST_NAME`. The workflow uses the UAT
`DATABASE_URL` and `ADMIN_BETTER_AUTH_SECRET`.

If the configured Admin already exists, the UAT workflow treats the seed as a
successful no-op. It does not change that Admin's credentials. If a different
Admin exists, the seed step fails. Staging is unchanged.

If the standalone command reports an existing Admin, stop that bootstrap.
The command never updates or resets an existing Admin. Verify sign-in to the
Admin web app with these credentials before closing the deployment.

---

## 🌐 Cloudflare Tunnel (Optional for Webhooks)

To expose your local server for external Payment Webhooks (e.g. Xendit Test Mode):

```bash
# Set CLOUDFLARE_TUNNEL_TOKEN in .env
docker compose --profile tunnel up -d cloudflared
docker compose logs -f cloudflared
```

Stop the tunnel:

```bash
docker compose --profile tunnel stop cloudflared
```

---

## 🛑 Stopping Services

```bash
docker compose stop           # Stop containers, preserve database volumes
docker compose down           # Remove containers, preserve volumes
docker compose down --volumes # Remove containers and wipe database volumes
```
