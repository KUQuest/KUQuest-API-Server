# Admin Finance Endpoints Specification and Implementation Plan

## 1. Context and Objective

The KUQuest API Server enforces double-entry accounting (`ADR 0006`) with integer Satang representation (`ADR 0005`).
The Admin Web Application needs dedicated read endpoints to audit Quest financial lifecycles, query the system-wide double-entry ledger, inspect platform revenue and circulating balances, audit individual member wallets, and view inbound PromptPay top-ups.

This document defines the accepted target endpoints, request/response models, database queries, error handling, and test requirements.

---

## 2. Ubiquitous Language & Core Rules

- **Wallet**: 4 compartments: `Spending Balance`, `Earnings Balance`, `Funding Reserved`, `Reserved For Payouts`.
- **Satang**: Integer units representing currency ($1\text{ THB} = 100\text{ Satang}$).
- **Zero-Sum Invariant**: Every double-entry transaction must sum to zero:
  $$\sum \text{amountSatang} = 0$$
- **Funding Reservation**: Generic escrow hold for a Quest (`callerScope = 'quest'`, `callerReference = questId`).
- **Ledger Event Types**:
  - `TOP_UP`: Inbound deposit into Member `Spending Balance`.
  - `PAYOUT`: Outbound withdrawal from Member `Reserved For Payouts`.
  - `FUNDING_RESERVE`: Hold from Hirer `Spending Balance` into Hirer `Funding Reserved`.
  - `FUNDING_SETTLEMENT`: Escrow distribution to Worker `Earnings Balance` + `PLATFORM_REVENUE`.
  - `FUNDING_RELEASE`: Release of unspent escrow back to Hirer `Spending Balance`.
  - `EARNINGS_CONVERSION`: Transfer from Member `Earnings Balance` to `Spending Balance`.
  - `ADJUSTMENT`: Reversing transaction or dispute settlement.
- **Admin Access**: All endpoints require an enabled Admin session (`enabledAdminGuard`).

---

## 3. Detailed Endpoint Contracts

### 3.1 `GET /api/v1/admin/finance/quests/:questId`
Audits the complete money flow and ledger transactions for a single Quest.

- **URL Parameters**:
  - `questId` (UUID): The Quest ID.
- **Error Responses**:
  - `401 Unauthorized`: Missing or invalid Admin session.
  - `403 Forbidden`: Admin account disabled.
  - `404 QUEST_NOT_FOUND`: No Quest exists with this ID.
- **Data Returned**:
  - `questId`, `title`, `questStatus`, `headcount`, `rewardSatang`, `platformFeePerWorkerSatang`, `questFundingTotalSatang`.
  - `hirer`: `userId`, `firstName`, `lastName`, `studentId`.
  - `reservation`: `id`, `status` (`ACTIVE`, `RELEASED`, `SETTLED`), `totalReservedSatang`, `remainingSatang`, `createdAt`.
  - `transfers`: Chronological list of human-readable transfer steps ($A \rightarrow B$):
    - `id`, `occurredAt`, `type` (`RESERVE`, `SETTLEMENT`, `RELEASE`, `DISPUTE_SETTLEMENT`).
    - `from`: `{ type: 'HIRER' | 'QUEST_ESCROW', id: string, displayName: string }`.
    - `to`: `{ type: 'QUEST_ESCROW' | 'WORKER' | 'PLATFORM_REVENUE' | 'HIRER', id: string, displayName: string }`.
    - `amountSatang`, `platformFeeSatang`, `description`, `ledgerTransactionId`, `businessReference`.
  - `ledgerTransactions`: Direct double-entry postings for verification:
    - `id`, `businessReference`, `eventType`, `description`, `createdAt`, `sealedAt`.
    - `postings`: `accountId`, `accountType`, `walletId`, `ownerUserId`, `amountSatang`.

### 3.2 `GET /api/v1/admin/finance/ledger/transactions`
General ledger transaction query and pagination for system auditability.

- **Query Parameters**:
  - `eventType` (optional): Filter by `LedgerEventType`.
  - `userId` (optional): Filter transactions touching this user's accounts.
  - `walletId` (optional): Filter transactions touching this wallet.
  - `businessReference` (optional): Exact or prefix match.
  - `from` (optional): ISO8601 start timestamp.
  - `to` (optional): ISO8601 end timestamp.
  - `limit` (optional): Integer, default 20, max 100.
  - `cursor` (optional): Base64-encoded cursor or transaction ID.
- **Data Returned**:
  - `items`: Array of ledger transactions with:
    - `id`, `businessReference`, `eventType`, `description`, `createdByUserId`, `correctionOfTransactionId`, `createdAt`, `sealedAt`.
    - `isBalanced`: boolean ($\sum \text{amountSatang} == 0$).
    - `postings`: Array of postings with `id`, `accountId`, `accountType`, `walletId`, `member` (`userId`, `name`, `studentId`), and `amountSatang`.
  - `nextCursor`: Next pagination cursor or `null`.

### 3.3 `GET /api/v1/admin/finance/overview`
Platform-level financial metrics and subledger balance sheet.

- **Data Returned**:
  - `platformBalances`:
    - `revenueSatang`: Cumulative platform fees in `PLATFORM_REVENUE`.
    - `suspenseSatang`: Clearing balance in `PLATFORM_SUSPENSE`.
  - `memberBalancesSummary`:
    - `totalSpendingSatang`: Sum of all `SPENDING` accounts.
    - `totalEarningsSatang`: Sum of all `EARNINGS` accounts.
    - `totalFundingReservedSatang`: Sum of all active escrow holds in `FUNDING_RESERVED`.
    - `totalPayoutReservedSatang`: Sum of all `RESERVED_FOR_PAYOUTS` accounts.
    - `totalCirculatingSatang`: Sum of member funds.
  - `volumeLifetime`:
    - `totalTopUpDepositedSatang`: Sum of all completed `TOP_UP` transactions.
    - `totalPayoutCompletedSatang`: Sum of all completed `PAYOUT` transactions.
    - `totalPlatformFeesEarnedSatang`: Total fees retained from settlements.
  - `integrity`:
    - `subledgerBalanced`: boolean ($\sum \text{all accounts} == 0$).
    - `totalPostingsDiscrepancySatang`: Integer delta (must be 0).
    - `lastAuditedAt`: ISO8601 timestamp.

### 3.4 `GET /api/v1/admin/finance/members/:userId`
Audits an individual Member's financial positions, lifetime volume, and active holds.

- **URL Parameters**:
  - `userId` (UUID): The Member's user ID.
- **Error Responses**:
  - `404 MEMBER_NOT_FOUND`: No user exists with this ID.
- **Data Returned**:
  - `userId`, `firstName`, `lastName`, `studentId`, `email`.
  - `wallet`:
    - `id`, `walletStatus`, `spendingBalanceSatang`, `earningsBalanceSatang`, `fundingReservedSatang`, `reservedForPayoutsSatang`.
    - `projectionMatchesLedger`: boolean.
  - `lifetimeStats`:
    - `totalToppedUpSatang`, `totalEarnedFromQuestsSatang`, `totalSpentOnQuestsSatang`, `totalPaidOutSatang`, `totalEarningsConvertedSatang`.
  - `activeFundingReservations`:
    - Array of active holds (`id`, `callerReference`, `totalReservedSatang`, `remainingSatang`, `createdAt`).

### 3.5 `GET /api/v1/admin/top-ups`
Exposes the list of inbound PromptPay top-ups for Admin audit and reconciliation.

- **Query Parameters**:
  - `status` (optional): `PENDING` | `PAID` | `EXPIRED` | `FAILED`.
  - `userId` (optional): UUID.
  - `limit` (optional): Integer, default 20, max 100.
  - `cursor` (optional): Base64-encoded cursor or UUID.
- **Data Returned**:
  - `items`: Array of top-up records (`id`, `userId`, `member` name and studentId, `status`, `amountSatang`, `providerFeeSatang`, `totalChargeSatang`, `expiresAt`, `paidAt`, `createdAt`).
  - `nextCursor`: Next pagination cursor or `null`.

---

## 4. Implementation Steps

1. **Schemas**:
   - `src/modules/admin/admin-finance.schema.ts`: TypeBox schemas for all 4 finance endpoints.
   - `src/modules/top-up/top-up.admin.schema.ts`: Extend with `adminTopUpListQuerySchema` and `adminTopUpListResponseSchema`.
2. **Services**:
   - `src/modules/admin/admin-finance.service.ts`: Database query functions with proper relational joins and balance calculations.
   - `src/modules/top-up/top-up.admin.service.ts`: Top-up listing query with pagination.
3. **Controllers & Routes**:
   - `src/modules/admin/admin-finance.controller.ts` & `src/modules/admin/admin-finance.route.ts`: Mount under `${API_V1_PREFIX}/admin/finance`.
   - Update `src/modules/top-up/top-up.admin.controller.ts` & `src/modules/top-up/top-up.admin.route.ts` to add `GET /`.
   - Update `src/modules/admin/index.ts` and `src/app.ts` to register `adminFinanceRoute`.
4. **Integration Tests**:
   - `tests/modules/admin/admin-finance.integration.test.ts`: Verify all endpoints against real PostgreSQL transactions.
   - `tests/modules/top-up/top-up.admin.integration.test.ts`: Verify top-up list endpoint.
5. **Quality Gates**:
   - `bun run db:check`, `bun run lint`, `bun run typecheck`, `bun test`, `bun run build`.
