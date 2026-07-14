# KUQuest MVP handoff

Snapshot: 14 July 2026  
Branch: `feature/better-auth-api-integration`  
Latest implementation commit: `48141b1 fix: complete selected worker submission flow`

## 1. What was built

KUQuest now has a development MVP that demonstrates a real, auditable money path:

1. A real `@ku.th` user signs in through Google and Better Auth.
2. The user creates a Xendit test-mode PromptPay payment request.
3. Xendit sends an authenticated payment webhook and KUQuest credits the spending wallet once.
4. The employer creates a funded job; money moves from spending into held-for-jobs.
5. A synthetic user behaves as a normal worker, applies, is selected, and submits work.
6. The employer approves the work; held value moves into the worker's earnings wallet.
7. The worker creates a Xendit test-mode payout; earnings are reserved until the payout webhook succeeds or fails.

The browser is a Vue 3 application designed as a normal user journey rather than an administrator console. It includes role switching for synthetic users and detailed, redacted API diagnostics in a separate drawer.

Disputes remain in the database design but are intentionally outside the current showcase flow. No existing dispute tables or unrelated features were removed.

## 2. Current application structure

```text
Browser: Vue 3 + Vite
  web/src/App.vue                 Main five-step money journey
  web/src/api.ts                 API envelopes, error handling, redacted request log
  web/src/job-flow.ts            Worker/user identity helpers
  web/src/components/            Flow, money cards, diagnostics drawer
          |
          v
Elysia API
  src/app.ts                     Composition root and background webhook drain
  src/modules/auth/              Better Auth, Google login, @ku.th policy, CSRF
  src/modules/dev-test/          Synthetic users, actor sessions, diagnostics
  src/modules/money/             Wallet reads, ledger activity, webhook intake
  src/modules/payments/          Top-up/payout APIs, Xendit client and processing
  src/modules/jobs/              Funded jobs, applications, submission, settlement
          |
          v
PostgreSQL
  Better Auth tables
  Wallets + append-only balanced ledger
  Jobs + applications + submissions
  Top-ups + payouts + status histories
  Durable provider webhook inbox
  Idempotency keys, policy snapshots, audit/operations tables
          ^
          |
Xendit test mode
  Payment Requests V3 / PromptPay
  Payouts V2
  Authenticated webhooks through a Cloudflare Quick Tunnel
```

Compiled frontend assets are placed in `public/` and served by Elysia only in development mode.

## 3. Main modules

| Area | Responsibilities | Important files |
| --- | --- | --- |
| App composition | Routes, repositories, timers, plugins | `src/app.ts`, `src/index.ts` |
| Authentication | Google-only Better Auth, KU domain restriction, session resolution, CSRF | `src/modules/auth/` |
| Test actors | Create zero-balance synthetic normal users and switch browser identity | `src/modules/dev-test/` |
| Wallet and ledger | Wallet balances, activity, balanced postings, idempotency | `src/modules/money/`, `src/database/schema/ledger.schema.ts` |
| Jobs | Fund, apply, select, submit, approve and settle | `src/modules/jobs/` |
| Payments | PromptPay top-ups, payout accounts, payout quotes, Xendit calls | `src/modules/payments/` |
| Webhooks | Constant-time token verification, durable inbox, deduplication, processing | `src/modules/money/webhook.route.ts`, `src/modules/payments/postgres-payments.repository.ts` |
| UI | Five-step desktop-first journey and debug logging | `web/src/` |
| Database | Drizzle schema and forward migrations | `src/database/schema/`, `drizzle/` |

## 4. Money invariants

- API amounts and wallet balances are whole Thai baht integers.
- Xendit fee/tax snapshots use satang where provider precision is needed.
- Wallet compartments are `spending`, `earnings`, `held_for_jobs`, and `reserved_for_payouts`.
- Every value movement uses a balanced ledger transaction. Direct application-role balance mutation is blocked by database controls.
- Ledger transactions must balance to zero before sealing and cannot be edited after sealing.
- Job fees and payment policies are snapshotted so later policy changes do not rewrite old transactions.
- Mutating business commands use idempotency keys and stable request hashes.
- Xendit webhook delivery is authoritative. An API acceptance response alone never finalizes wallet value.
- Webhooks are authenticated, stored before acknowledgement, deduplicated, and processed by a retrying background drain.

## 5. User-facing flow

### Authentication and test users

- Open `http://localhost:5000` and sign in with Google.
- Only the `ku.th` domain and its subdomains pass the email policy.
- Create a synthetic worker from the actor bar. It receives a real application user row, wallet, and ledger accounts with zero balances.
- Actor switching is backed by an opaque, HTTP-only cookie. Only its hash is stored in the database, and a valid real root session remains required.

### Top-up

- Create a quote, then create the Xendit payment request.
- The Xendit V3 channel is `PROMPTPAY`; `QRPROMPTPAY` is not enabled for this integration.
- The QR may not be payable by a real banking app in test mode.
- The development simulation endpoint calls Xendit's test simulator with the stored payment amount.
- The simulator returns pending first. The payment webhook completes the wallet credit.

### Funded job and worker earnings

- Creating a job moves value from employer spending to held-for-jobs atomically.
- A different user applies to the open job.
- The employer selects one pending application.
- The UI now shows the applicant name, opens the submission step, and automatically switches the test browser to that selected worker.
- The selected worker may submit while the job is `ASSIGNED` or `OVERDUE`.
- Employer approval moves held value into worker earnings and changes the job to `SETTLED`.
- Generic user-to-user transfers are not part of this MVP. Money reaches a worker only through approved work.

### Payout

- A worker saves a payout destination, requests a quote, and creates a Xendit Payouts V2 transaction.
- KUQuest reserves earnings before calling Xendit.
- A success webhook finalizes the debit. A failure webhook releases the reservation back to earnings.
- Xendit's create response normally starts at `ACCEPTED`; KUQuest exposes this locally as `PENDING` until a terminal callback.

## 6. API map

All first-party JSON endpoints use the canonical `{ success, data, error, trace_id }` envelope. Mutating job/top-up/payout endpoints require an `Idempotency-Key` header where defined.

### Core and authentication

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | Service health |
| ALL | `/api/auth/*` | Better Auth handlers |
| GET | `/api/auth/get-session` | Current Better Auth session |

### Development-only user testing

| Method | Path | Purpose |
| --- | --- | --- |
| GET/POST | `/v1/development/test-users` | List or create synthetic normal users |
| POST | `/v1/development/actor-sessions` | Act as a synthetic user |
| DELETE | `/v1/development/actor-session` | Return to the real root user |
| GET | `/v1/development/session-context` | Root/effective identity |
| GET | `/v1/development/money-diagnostics` | Sanitized ledger and webhook diagnostics |

### Wallet, top-ups, and payouts

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/v1/wallet` | Current wallet balances |
| GET | `/v1/wallet/activities` | Wallet activity feed |
| POST | `/v1/wallet/top-up-quotes` | Quote a top-up |
| POST/GET | `/v1/wallet/top-ups` | Create/list top-ups |
| GET | `/v1/wallet/top-ups/:id` | Get top-up state |
| POST | `/v1/wallet/top-ups/:id/simulate` | Development-only Xendit payment simulation |
| GET/POST | `/v1/wallet/payout-account` | Get/replace payout destination |
| POST | `/v1/wallet/payout-quotes` | Quote a payout from earnings |
| POST/GET | `/v1/wallet/payouts` | Create/list payouts |
| GET | `/v1/wallet/payouts/:id` | Get payout state |

### Funded jobs

| Method | Path | Purpose |
| --- | --- | --- |
| GET/POST | `/v1/jobs` | List or fund a job |
| GET | `/v1/jobs/:job_id` | Job detail |
| POST | `/v1/jobs/:job_id/cancellation` | Cancel an unassigned job |
| GET/POST | `/v1/jobs/:job_id/applications` | Employer list / worker apply |
| GET | `/v1/jobs/:job_id/my-application` | Current worker application |
| POST | `/v1/jobs/:job_id/worker-selection` | Employer selects applicant |
| GET/POST | `/v1/jobs/:job_id/work-submission` | Read or submit work |
| POST | `/v1/jobs/:job_id/approval` | Employer approves and settles |

### Xendit webhooks

| Xendit dashboard product | URL |
| --- | --- |
| Payment Requests V3: Payment Status / Payment Request Status | `https://<public-host>/v1/webhooks/xendit/payments` |
| Payouts v2 | `https://<public-host>/v1/webhooks/xendit/payouts` |

Both webhook endpoints require the configured Xendit callback token and return HTTP `202` after durable acceptance.

## 7. Database groups

| Group | Main tables |
| --- | --- |
| Better Auth | `user`, `session`, `account`, `verification` |
| Access | `roles`, `user_role_assignments` |
| Wallet/ledger | `wallets`, `ledger_accounts`, `ledger_transactions`, `ledger_postings`, `wallet_activities`, `wallet_status_history` |
| Policy/idempotency | `money_policy_revisions`, `idempotency_keys` |
| Jobs | `jobs`, `job_status_history`, `job_applications`, `job_application_status_history`, `work_submissions`, `work_submission_status_history` |
| Payments | `top_up_quotes`, `top_ups`, `top_up_status_history`, `payout_accounts`, `payout_quotes`, `payouts`, `payout_status_history` |
| Provider operations | `provider_webhook_events`, `provider_webhook_event_status_history`, `reconciliation_runs`, `scheduled_tasks`, `platform_controls` |
| Development actors | `development_test_users`, `development_actor_sessions` |
| Deferred disputes | `disputes`, `dispute_status_history`, `dispute_resolutions`, `dispute_resolution_approvals` |

Triggers provision a wallet and its four user ledger accounts when a valid KU user is created. Five system ledger accounts are seeded by migrations.

## 8. Run locally

Prerequisites: Bun, Docker with Compose, and Cloudflared for public webhooks.

Real local credentials live in the shared `../../.env`; do not commit that file or paste its values into documentation.

```sh
docker compose up -d postgres
docker compose run --rm migrate
bun run dev:local
```

Open `http://localhost:5000`.

In another terminal, after local health is green:

```sh
bun run tunnel
```

Quick Tunnel hostnames are temporary. Update both Xendit test webhook URLs whenever the hostname changes. Keep Google OAuth callbacks on the local application origin unless the OAuth configuration is deliberately changed.

Useful commands:

```sh
bun run typecheck
bun test
bun run build
bun run check
```

To destructively recreate only the local database:

```sh
docker compose down -v
docker compose up -d postgres
docker compose run --rm migrate
```

This removes users, sessions, wallets, jobs, payments, and webhooks. It does not remove source code or Git commits.

## 9. Xendit configuration and test behavior

Required environment variable names:

- `XENDIT_SECRET_KEY`
- `XENDIT_WEBHOOK_TOKEN` (or legacy alias `XENDIT_WEBHOOK_VERIFICATION_TOKEN`)
- `PUBLIC_API_URL` when a public origin is required

Never put the values in Git, browser logs, screenshots, or handoff documents.

Important test-mode payout numbers:

| Account number | Xendit test result |
| --- | --- |
| Ordinary valid-looking value | `SUCCEEDED` |
| `121212` | `FAILED` / `INVALID_DESTINATION` |
| `123456` | `FAILED` / `TEMPORARY_TRANSFER_ERROR` |
| `999999` | `FAILED` / `REJECTED_BY_CHANNEL` |
| `131313` | Remains `ACCEPTED` for cancellation testing |
| `654321` | `SUCCEEDED`, then `REVERSED` |

The most recent inspected payout used `121212`. Xendit accepted it initially, then delivered `payout.failed` with `INVALID_DESTINATION`. KUQuest processed that webhook correctly and changed the database record from `PENDING` to `FAILED`.

## 10. Known issues and next work

1. **Payout UI polling:** after creating a payout, the UI refreshes only once. A later webhook may update the database while the screen still shows `PENDING`. Add polling similar to top-ups, stop on terminal states, and refresh wallet/activity data.
2. **Bad payout form default:** `web/src/App.vue` currently defaults the account number to `121212`, which deliberately triggers Xendit's invalid-destination scenario. Replace it with a non-reserved successful test value and label special test scenarios separately.
3. **Payout failure detail:** the webhook payload stores `failure_code`, but the public payout model/UI does not expose a safe failure reason. Add a nullable failure code to the durable payout projection and UI.
4. **Durable diagnostics UX:** keep redaction rules intact if adding provider-status detail. Never expose complete account numbers, QR strings, callback tokens, or raw webhook payloads.
5. **Full database integration tests:** the normal test command skips seven PostgreSQL integration cases unless `TEST_DATABASE_URL` points to an isolated migrated test database.
6. **Lint baseline:** the last full lint invocation reported two existing `no-base-to-string` errors in `tests/modules/payments/xendit.client.test.ts`; tests, type-check, and build passed. Fix the request-body capture typing before treating `bun run check` as green.
7. **Disputes and reconciliation:** database structures exist, but the UI/API showcase intentionally postpones the dispute workflow and operational reconciliation controls.
8. **Production hardening:** Quick Tunnels are only for temporary testing. Production requires a stable domain, HTTPS, durable secret management, correct trusted origins, production OAuth callbacks, monitoring, and a deployment-specific database migration process.

## 11. Verification snapshot

At the last completed implementation verification:

- `bun test`: 49 passed, 0 failed, 7 skipped because no test database URL was supplied.
- TypeScript and Vue type-check: passed.
- Production Vue and Bun build: passed.
- Changed worker-flow files passed lint, with one pre-existing style warning in the route integration test.
- Local `/health`: HTTP 200.
- Local UI: HTTP 200.
- Cloudflare Quick Tunnel: HTTP 200 at the time of testing.
- The database was fully reset and migrations replayed successfully before the latest manual money-flow test.

## 12. Relevant commits

| Commit | Purpose |
| --- | --- |
| `48141b1` | Complete selected-worker submission UX and tests |
| `e7f88ef` | Include stored amount in Xendit payment simulation |
| `38812dd` | Use enabled Xendit `PROMPTPAY` channel |
| `23d2b34` | Rebuild the test experience with Vue 3 and Vite |
| `1b1b37e` | Add reliable local development launcher |
| `3c0b7e2` | Persist and log Xendit webhooks safely |
| `101c6f2` | Add MVP money-flow testing experience |
| `2f8a68b` | Integrate Better Auth wallet foundation |

## 13. Security handoff

- The Xendit webhook token and API key are intentionally omitted from this document.
- Rotate any secret that was pasted into chat, tickets, screenshots, or other shared systems.
- Keep provider callbacks authenticated and compare tokens in constant time.
- Preserve CSRF origin validation on browser mutations.
- Preserve idempotency and database-level ledger protections when adding endpoints.
- Treat the synthetic actor feature as development-only; it must remain disabled in production.

