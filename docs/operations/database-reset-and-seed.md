# Database reset and seed operations

These commands are for development and staging only. They apply the complete
committed Drizzle migration chain, then create the supported demo data.

## Local database

The local reset accepts only a development environment and a localhost
`DATABASE_URL`. It drops and recreates only the `public` schema. Type the exact
confirmation through an environment variable:

```bash
CONFIRM_LOCAL_DB_RESET='RESET local database' \
  bun run db:reset-local
```

The command runs `db:migrate` and verifies every committed migration hash and
timestamp in `drizzle.__drizzle_migrations`. Configure Admin credentials,
`STAGING_TEST_AUTH_PASSWORD`, and the five `S3_*` storage values, then run:

```bash
bun --env-file=.env.admin run db:seed-staging
bun --env-file=.env.admin run db:verify-staging-seed
```

This is one flow: Quest Tags → Admin → 10 demo Members → 10 funded Published
Quests. `seed-demo-users.ts` alone owns Member creation and complete Profiles.
`seed-demo-quests.ts` uses those Members, credits starter funds with sealed
`ADJUSTMENT` Ledger Transactions, stores Quest pictures, and publishes through
the normal v2 Quest service. Each fresh Wallet has ฿1,000 available after funding.
Pictures are bundled in `scripts/demo-assets`; seeding needs object storage but
no public picture download. Sources are recorded in that folder's README.

The flow runs only in development/development or production/staging. If Xendit
is configured, its key must be a Development key. Seeding makes no provider call.
It does not create Payouts, Payout Destinations, Reviews, or Dispute Cases.

Run `db:seed-demo-users` and `db:seed-demo-quests` separately only to repeat a
specific step. Stable identities prevent duplicates and starter credit repeats.
Existing participation, terminal decisions, and later Wallet activity are preserved.
Verification is for a fresh bootstrap; it expects all Quests still OPEN and the
starter Spending Balances still untouched. Existing databases need the reset
procedure below to remove old fixtures; the seed does not delete financial history.

## Staging database

Every staging CD run deploys the validated image, then runs `db:seed-staging`
once. CD checks sign-in and Profile access for all 10 demo Members. It does not
reset the database. Repeat seed runs preserve Quest activity and do not repeat
starter credit. `db:verify-staging-seed` is a separate check for a fresh bootstrap;
it is not used after each CD run because Members can change their Wallets and Quests.

CD also runs a dedicated Admin seed step after deployment and before the demo
seed. It invokes `scripts/seed-admin.ts` to create the configured Admin when
needed. A repeat run leaves that Admin unchanged. The existing demo seed and
login verification steps stay in place.

CD verifies demo Member logins with Bun in the validated API image. For HTTP 429,
it waits for the Server's retry delay and retries the login at most twice.
Merge CD workflow fixes into `main` before merging the next PR into `develop`.
That `develop` push starts CI and then a new CD run with the updated workflow.

The one-time staging bootstrap runs from the validated API image:

```bash
APP_IMAGE=ghcr.io/kuquest/kuquest-api-server:<validated-sha> \
STAGING_DIR=/opt/backend \
ENV_FILE=/opt/backend/.env \
BACKUP_DIR=/opt/backend/backups \
STAGING_NETWORK=kuquest-staging_default \
bash scripts/staging-operations.sh bootstrap
```

The `ENV_FILE` must contain `DEPLOYMENT_ENV=staging`. The operation refuses to
read a different deployment target before it can run a destructive command.

Before the prompt, the operation creates a custom-format PostgreSQL backup and
checks it with `pg_restore --list`. Confirm the destructive operation with:

```text
RESET staging public schema
```

The reset drops and recreates only the target database's `public` schema. It
does not change PostgreSQL roles, the PostgreSQL server, other databases, or
production. The migration journal is cleared so the complete migration chain
can be applied and verified. The operation then runs the Quest Tags, Admin, demo
Member, and funded demo Quest steps,
and verifies the resulting records. Any failure after the backup reports the
recovery backup path.

To recover, stop the staging API, then restore the reported custom-format dump
from the staging server. Replace `BACKUP_NAME` with the reported file name:

```bash
DATABASE_URL='postgresql://kuquest:<password>@postgres:5432/kuquest'
BACKUP_NAME=kuquest-<timestamp>.dump
docker run --rm \
  --network kuquest-staging_default \
  --env DATABASE_URL \
  --volume /opt/backend/backups:/backups:ro \
  postgres:17-alpine \
  pg_restore --exit-on-error --clean --if-exists --no-owner \
  --dbname "$DATABASE_URL" "/backups/$BACKUP_NAME"
```

Use the disposable verification before a real staging reset:

```bash
set -a
source .env
source .env.admin
set +a
bash scripts/verify-staging-bootstrap.sh
```

The ignored `.env` file must contain S3 storage values. The ignored `.env.admin`
file must contain compliant local values for
`ADMIN_PASSWORD` and `STAGING_TEST_AUTH_PASSWORD`. In GitHub Actions, pass
these values from `secrets.ADMIN_PASSWORD` and
`secrets.STAGING_TEST_AUTH_PASSWORD`; never add either password to this
script.
