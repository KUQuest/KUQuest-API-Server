# KUQuest API Server

Backend API for KUQuest Mobile and CMS, built with Elysia and Bun.

## Requirements

- Bun: see `.bun-version`
- PostgreSQL 16+
- Git

## Setup

```bash
git clone <repository-url>
cd KUQuest-API-Server
cp .env.example .env
bun install --frozen-lockfile
bun run db:migrate
bun run dev
```

If the shared development variables are kept in the workspace-level `.env`, pass it explicitly instead of copying secrets:

```bash
bun --env-file=../../.env run db:migrate
bun --env-file=../../.env run dev
```

`DATABASE_URL` must resolve from the process environment. A Docker-internal hostname such as `postgres` works inside its Compose network; a server launched directly on the host normally uses `127.0.0.1`.

## Implemented money slice

- `GET /v1/wallet`
- `GET /v1/wallet/policy`
- `GET /v1/wallet/activities`
- `POST /v1/wallet/earnings-conversions`
- `POST /v1/webhooks/xendit/payments`
- `POST /v1/webhooks/xendit/payouts`

Wallet routes require an access JWT with a non-empty `sub` claim. The conversion route also requires an `Idempotency-Key` containing 16–100 characters.

The current migrations establish wallet projections, policy revisions, immutable balanced ledger transactions/postings, idempotency records, wallet activity, and the durable provider webhook inbox. Webhook endpoints authenticate `x-callback-token`, persist the event idempotently, and return `202`; asynchronous money effects are intentionally not part of this first slice.

## Verification

```bash
bun run check
```

PostgreSQL invariant tests are skipped unless `TEST_DATABASE_URL` is set:

```bash
TEST_DATABASE_URL=postgres://... bun test tests/money.postgres.test.ts
```

These tests verify balanced postings, ledger immutability, idempotent replay, projection rebuild, and concurrent overspend protection. Xendit public webhook delivery is not exercised locally; the handler itself is covered with in-process fixtures.
