# Reward and Money Contract

Part of the [Quest and Work Chat Rulebook](quest-work-chat-rulebook.md). Defines accepted policy for Quest Escrow funding, integer-satang calculation, settlement transfers, and failure hold.

## Inclusive Quest Funding Total

- The Hirer funds the Quest through `Quest Escrow`.
- The `Quest Funding Total` is the Hirer's inclusive amount for one published Worker slot. It contains that slot's `Quest Reward` and `Platform Fee`.
- At the v2 API boundary, the Hirer supplies this amount as `questFundingTotal` in Baht for one Worker slot. `Quest Reward` and `Platform Fee` are derived values; `reward` is not the v2 input name.
- The Server calculates the `Platform Fee` from the net `Quest Reward` using the snapshotted `Money Policy` and its required rounding mode. The `Quest Reward` is the Worker payment; the `Platform Fee` is not added after the funding total is set.
- After conversion to integer satang, the Server chooses the net `Quest Reward` as the greatest amount whose required fee does not exceed the `Quest Funding Total`. The required fee is `ceil(Quest Reward × fee rate)`, and the actual `Platform Fee` is `Quest Funding Total - Quest Reward`. A rounding remainder of up to one satang stays in the Platform Fee so the total is exact.
- At publish, `Quest Escrow` reserves the `Quest Funding Total` for every published `headcount` slot in integer satang.

## Publish and reservation atomicity

- A successful v2 publish returns the canonical `Quest` in `QUEST_OPEN` and a `Quest Escrow` snapshot in the response envelope, including opaque `reservationId`, inclusive total, net Reward, Platform Fee, and captured `Money Policy` revision.
- Publish requires `Idempotency-Key`. Concurrent requests use first-commit-wins.
- Quest state, finance snapshot, Funding Reservation, Wallet balance projections, ledger postings, and command result commit atomically. Any failure rolls back the transaction with no partial reservation.

## Visibility rules

- **Hirer reads**: May show `questFundingTotal`, `questReward`, `platformFee`, `platformFeeBps`, `feeRoundingMode`, `policyRevision`, and opaque `reservationId` for support and audit.
- **Worker and public reads**: Show only the applicable `questReward`. They do not show Platform Fee, Money Policy details, Wallet details, or Funding Reservation details.

## Settlement and failure rules

- The system transfers a Worker Reward immediately when that Assignment becomes `ASSIGNMENT_COMPLETED`.
- If a Reward transfer fails, the Assignment remains `ASSIGNMENT_COMPLETED`, the transfer remains `REWARD_TRANSFER_PENDING`, the system retries, and Hirer/Worker are notified. Retries reuse the same payment record and cannot create duplicate payments.
- **On `QUEST_FAILED`**:
  - Unpaid Worker-slot funding returns to the Hirer. Already transferred Rewards are not reclaimed.
  - That return is held for 7 days before the Hirer can spend it, so a Dispute Case still has funds to redirect (see `docs/rulebook/admin/admin-rulebook.md` §2 and `docs/adr/0024-hold-quest-failure-settlement-for-dispute-window.md`).
  - A failed Quest has no Platform Fee; the fee returns to the Hirer.
- **On cancellation**: Settlement follows the matrix in [Quest Lifecycle Contract](quest-lifecycle-contract.md). An `ASSIGNMENT_CANCELLED` Assignment receives no Reward.
