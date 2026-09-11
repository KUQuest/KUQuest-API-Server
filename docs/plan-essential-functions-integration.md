# Plan: Integration of Essential Unconnected Functions

Status: In Progress
Domain: Finance, Admin, Quest Lifecycle, Work Chat

## Overview

Connect essential services, lifecycle automation, and administrative capabilities that are implemented and tested in the service layer but missing from server runtime or HTTP routes.

---

## Phase 1: Server Startup & Webhook Event Clearing

- [ ] **1.1 Server Startup Money Policy**: Call `ensureInitialMoneyPolicy()` in `src/index.ts` before `app.listen()` so fresh environments never fail with `POLICY_NOT_AVAILABLE`.
- [ ] **1.2 Top-Up Webhook Event Clearing**: Trigger `processTopUpProviderEvents()` upon receiving Xendit webhooks in `top-up.webhook.controller.ts` and in a periodic sweep.
- [ ] **1.3 Payout Webhook Event Clearing**: Trigger `processPayoutProviderEvents()` upon receiving Xendit webhooks in `payout.webhook.controller.ts` and in a periodic sweep.

---

## Phase 2: Background Schedulers & Storage Cleanup

- [ ] **2.1 Payout Submission Scheduler**: Create `src/modules/payout/payout.scheduler.ts` running `processApprovedPayouts()` and start it in `src/index.ts`.
- [ ] **2.2 Work Chat Storage Cleanup**: Add `cleanupExpiredWorkChatAttachments()` to `runQuestLifecycleWorker` in `quest-lifecycle.worker.ts`.
- [ ] **2.3 Provider Event Retention Purge**: Add `purgeExpiredProviderEventPayloads()` to `runQuestLifecycleWorker` in `quest-lifecycle.worker.ts`.

---

## Phase 3: Admin Wallet Freeze and Suspend Endpoints

Under `docs/rulebook/admin/admin-wallet-freeze-contract.md` and `docs/reconciliation/admin-reconciliation.md` line 93:
- [ ] **3.1 Schema & Controller**: Define admin wallet status update schema (`FROZEN`, `SUSPENDED`, `ACTIVE`, `CLOSED`, mandatory reason) and controller calling `changeWalletStatus` in `src/modules/wallet/wallet.admin.controller.ts`.
- [ ] **3.2 Admin Routes**: Mount `POST /api/v1/admin/wallets/:walletId/status` and `GET /api/v1/admin/wallets/:walletId/status-history` protected by `enabledAdminGuard` in `src/modules/wallet/wallet.admin.route.ts` and mount in `src/app.ts`.

---

## Phase 4: Admin Payment Reconciliation & Webhook Retry Endpoints

Under `docs/rulebook/finance/finance-rulebook.md`:
- [ ] **4.1 Top-Up Reconciliation & Retry**: Expose `POST /api/v1/admin/top-ups/:topUpId/reconcile` and `POST /api/v1/admin/top-ups/events/:eventId/retry` in `src/modules/top-up/top-up.admin.route.ts` calling `reconcileTopUp` and `retryTopUpProviderEvent`.
- [ ] **4.2 Payout Reconciliation & Retry**: Expose `POST /api/v1/admin/payouts/:payoutId/reconcile` and `POST /api/v1/admin/payouts/events/:eventId/retry` in `src/modules/payout/payout.admin.route.ts` calling `reconcilePayout` and `retryPayoutProviderEvent`.

---

## Phase 5: Wallet Subledger Audit and Health Endpoints

Under `docs/adr/0006-ledger-is-financial-source-of-truth.md` and `docs/adr/0012-wallet-ledger-is-a-subledger.md`:
- [ ] **5.1 Wallet Verification Route**: Expose `GET /api/v1/admin/wallets/:walletId/verification` in `src/modules/wallet/wallet.admin.route.ts` calling `verifyWalletProjection`.
- [ ] **5.2 Wallet Rebuild Projection Route**: Expose `POST /api/v1/admin/wallets/:walletId/rebuild-projection` in `src/modules/wallet/wallet.admin.route.ts` calling `rebuildWalletProjection`.

---

## Verification Gates

- Typecheck: `bun run typecheck` passes with 0 errors.
- Lint: `bun run lint` passes with 0 errors.
- Test suites: `bun test tests/modules/auth/ tests/modules/wallet/ tests/modules/payout/ tests/modules/top-up/ tests/modules/admin/` all pass.
