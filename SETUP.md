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

*Tip: Always run `bun run db:migrate` after pulling changes that touch `drizzle/`.*

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
- **RustFS S3 Console**: [http://localhost:9001](http://localhost:9001) *(login with credentials from `.env`)*
- **Drizzle Studio**: `bun run db:studio` -> [https://local.drizzle.studio](https://local.drizzle.studio)

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

### Database Seeding Scripts

```bash
# Seed initial Admin user (requires .env.admin with credentials)
bun --env-file=.env.admin run db:seed-admin

# Seed demo users & test data
bun run db:seed-demo-users
bun run db:seed-frontend-demo
bun run db:seed-finance-test
```

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

The seed is the supported first-Admin bootstrap. It requires the six values
shown above. It exits with status 1 and makes no changes when any Admin already
exists, including an Admin with a different email. Credential creation goes
through Better Auth, which stores a password hash in `auth_account`; the
plaintext password is never stored or printed. Keep `.env.admin` outside source
control and run this command only in the controlled deployment workflow.

Run the seed script:
```bash
bun --env-file=.env.admin run db:seed-admin
```

If the command reports that an Admin already exists, stop the bootstrap. This
seed never updates or resets an existing Admin. Verify the bootstrap by signing
in to the Admin web app with these credentials before you close the deployment.

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
