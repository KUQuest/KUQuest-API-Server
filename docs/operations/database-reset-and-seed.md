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
timestamp in `drizzle.__drizzle_migrations`. To load the demo and finance test
data after the reset, configure the Admin, staging test Student, Payout
Destination encryption key, and Xendit Development API key, then run:

```bash
STAGING_FINANCE_SEED_ENABLED=true bun run db:seed-staging
bun run db:verify-staging-seed
```

The finance seed creates its Wallet balances with sealed `ADJUSTMENT` Ledger
Transactions. It creates the Payout Destination through the Payout Destination
service and creates a pending Payout through the Payout service. An Admin can
approve or reject this Payout. The seed does not call Xendit. It refuses to run
unless the Xendit key starts with `xnd_development_` and the explicit
finance-seed flag is set.

## Staging database

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
can be applied and verified. The operation then runs the Admin, demo Student,
demo Quest, Assignment, Review, and finance seeds, and verifies the resulting
records. Any failure after the backup reports the recovery backup path.

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

Staging must use an Xendit Development API key. The finance seed prepares a
Payout waiting for an Admin decision without submitting a provider Payout.
The Admin can then approve or reject a Payout through the normal Admin API;
provider submission remains a separate Worker operation.

Use the disposable verification before a real staging reset:

```bash
bash scripts/verify-staging-bootstrap.sh
```
