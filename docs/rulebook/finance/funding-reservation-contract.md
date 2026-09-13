# Funding Reservation Contract

Part of the [Finance Rulebook](finance-rulebook.md). Defines accepted policy for generic Funding Reservations, Quest Escrow locking, partial settlements, releases, and the 7-day failure money hold.

## Decoupled reservation architecture (ADR 0009)

- Funding Reservations (`wallet_funding_reservations`) are decoupled from the Quest domain model.
- A reservation is identified by `ownerUserId`, `callerScope` (e.g., `'QUEST'`), and an opaque `callerReference` (e.g., `questId`).
- The Quest module decides when to reserve, settle, or release; the Finance module executes the balance movements and ledger postings.

## Reservation lifecycle and statuses

| Status     | Invariant Condition   | Description                                                                                         |
| ---------- | --------------------- | --------------------------------------------------------------------------------------------------- |
| `ACTIVE`   | `remainingSatang > 0` | Funds are held in `FUNDING_RESERVED`. Available for settlement or release.                          |
| `RELEASED` | `remainingSatang = 0` | All unspent funds have been returned to the owner's `SPENDING` balance.                             |
| `SETTLED`  | `remainingSatang = 0` | All reserved funds have been completely distributed to recipient `EARNINGS` and `PLATFORM_REVENUE`. |

## Operations

Every operation creates an immutable audit row in `wallet_funding_reservation_operations` and an atomic ledger transaction:

1. **`RESERVE`**:
   - Moves `totalReservedSatang` from Hirer's `SPENDING` to `FUNDING_RESERVED`.
   - Executed atomically with Quest publish. If insufficient funds or wallet capacity overflow occurs, the entire transaction rolls back.
2. **`SETTLE`**:
   - Deducts net Reward and Platform Fee from `remainingSatang`.
   - Credits Worker `EARNINGS` with net `Quest Reward` and credits `PLATFORM_REVENUE` with `Platform Fee`.
   - Separately idempotent per Worker Assignment.
3. **`RELEASE`**:
   - Deducts remaining Satang from `FUNDING_RESERVED` and credits Hirer's `SPENDING`.
   - Changes status to `RELEASED`.

## 7-Day Money Hold on Failed Quests (ADR 0024)

- When a Quest becomes `QUEST_FAILED`, unpaid funding is **not** released immediately to ordinary Spending Balance.
- The Quest's Funding Reservation remains `ACTIVE` for **7 days** with the returned funds as `remainingSatang`.
- **Purpose**: Enables post-failure Proof approvals (which settle directly from this held reservation) and Dispute Case resolutions (which redirect funds from this held reservation).
- **Auto-release**: Exactly 7 days after failure, a background job releases any remaining funds to the Hirer's `SPENDING` balance.
