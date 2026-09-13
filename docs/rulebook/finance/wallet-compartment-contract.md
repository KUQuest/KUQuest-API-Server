# Wallet Compartment and Capacity Contract

Part of the [Finance Rulebook](finance-rulebook.md). Defines accepted policy for Student Wallet compartments, integer-satang arithmetic, total capacity limits, and wallet statuses.

## Integer Satang representation

- All monetary amounts in KUQuest use a 32-bit PostgreSQL `INTEGER` count of **integer satang** (1 Baht = 100 Satang) across storage and application services (ADR 0005).
- Baht is used exclusively for presentation in the UI.
- Arithmetic is strictly non-negative; negative intermediate balances fail closed.

## Four Wallet compartments

A Student Wallet (`wallet_wallets`) projects four distinct compartments from authoritative ledger postings:

1. **`spendingBalanceSatang`**: Uncommitted funds available for Top-up, publishing new Quests (Escrow reservations), or converting from Earnings.
2. **`earningsBalanceSatang`**: Net Quest Rewards earned by the Student from completed Assignments. May be converted to Spending Balance (fee-free) or withdrawn via Payout.
3. **`fundingReservedSatang`**: Funds committed to active Quest Escrow Funding Reservations. Cannot be spent or withdrawn until settled or released.
4. **`reservedForPayoutsSatang`**: Funds committed to submitted Payout requests pending Admin approval or external provider clearing.

## Capacity and overflow safeguards

- **Maximum Wallet Capacity**: The sum of all four compartments in a single Wallet must never exceed **2,000,000,000 Satang** (฿20,000,000).
- Inbound funds (Top-ups, Earnings, or Conversions) that would cause total compartments to exceed 2,000,000,000 Satang fail closed without creating ledger entries or taking money from external sources.
- **Maximum Single Operation**: A single transaction amount must not exceed 2,000,000,000 Satang.

## Wallet statuses and permissions

A Student Wallet has one of four statuses (`wallet_wallets.wallet_status`):

| Status      | Meaning                                     | Permissions & Constraints                                                                                                                                                                                                                       |
| ----------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ACTIVE`    | Normal operating status.                    | Full access to all financial operations (Top-up, Payout, Quest publish, Candidate application, Earnings conversion).                                                                                                                            |
| `FROZEN`    | Temporary hold (investigation or auto-ban). | Blocks **starting** new financial commitments (Top-up, Payout request, Conversion, Quest publish, joining Quests). In-progress commitments (active Escrow, active Assignments, pending Payouts) run to completion. Auto-restores on ban expiry. |
| `SUSPENDED` | Administrative hold.                        | Blocks starting new financial commitments. In-progress commitments run to completion. Requires explicit Admin action to return to `ACTIVE`.                                                                                                     |
| `CLOSED`    | Account terminated.                         | Permanent closure. Cannot initiate any new operations.                                                                                                                                                                                          |

Every status change is recorded in `wallet_status_history` with the actor (`actorUserId` or `actorAdminId`), timestamp, and mandatory reason.
