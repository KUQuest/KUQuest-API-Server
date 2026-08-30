# Double-Entry Ledger Contract

Part of the [Finance Rulebook](finance-rulebook.md). Defines accepted policy for the double-entry accounting engine, ledger account types, balancing rules, transaction immutability, and reversing transactions.

## Authoritative source of truth

- The balanced double-entry ledger (`wallet_ledger_transactions` and `wallet_ledger_postings`) is the sole financial source of truth (ADR 0006).
- Wallet balances, Escrow reservations, and activity feeds are denormalized projections updated atomically with ledger transactions.

## Ledger account types

There are six canonical account types (`wallet_ledger_accounts.type`):

### Student Wallet Accounts (Scoped per Wallet)
1. **`SPENDING`**: Holds uncommitted funds for Top-ups, Quest publication, and Earnings conversions.
2. **`EARNINGS`**: Holds net Quest Rewards earned from completed Assignments.
3. **`FUNDING_RESERVED`**: Holds committed Quest Escrow funding reservations.
4. **`RESERVED_FOR_PAYOUTS`**: Holds funds committed to pending Payout requests.

### Platform Accounts (Global / No Wallet ID)
5. **`PLATFORM_REVENUE`**: Accumulates realized Platform Fees upon successful Quest completion.
6. **`PLATFORM_SUSPENSE`**: Temporary clearing account for external payment provider settlement.

## Balanced posting rule (Zero-Sum Invariant)

Every ledger transaction must contain at least two postings, and the sum of `amountSatang` across all postings in that transaction must equal exactly zero:

$$\sum \text{amountSatang} = 0$$

- A debit posting carries a positive integer Satang amount.
- A credit posting carries a negative integer Satang amount.
- An unbalanced transaction fails database checks and cannot commit.

## Event types

There are seven canonical ledger event types:

| Event Type | Typical Postings |
| --- | --- |
| `TOP_UP` | `PLATFORM_SUSPENSE` (credit -) &rarr; Student `SPENDING` (debit +) |
| `PAYOUT` | Student `RESERVED_FOR_PAYOUTS` (credit -) &rarr; `PLATFORM_SUSPENSE` (debit +) |
| `FUNDING_RESERVE` | Student `SPENDING` (credit -) &rarr; Student `FUNDING_RESERVED` (debit +) |
| `FUNDING_RELEASE` | Student `FUNDING_RESERVED` (credit -) &rarr; Student `SPENDING` (debit +) |
| `FUNDING_SETTLEMENT` | Hirer `FUNDING_RESERVED` (credit -) &rarr; Worker `EARNINGS` (debit +) & `PLATFORM_REVENUE` (debit +) |
| `EARNINGS_CONVERSION` | Student `EARNINGS` (credit -) &rarr; Student `SPENDING` (debit +) |
| `ADJUSTMENT` | Direct correction postings between accounts via reversing transaction |

## Immutability and corrections (ADR 0010)

- Financial records are never updated or deleted. Once committed and sealed (`sealedAt IS NOT NULL`), a transaction is immutable.
- Correcting an error or resolving a dispute uses a **reversing transaction** linking to the original via `correctionOfTransactionId`.

## Subledger scope (ADR 0012)

The ledger proves Student Wallet balances, reservations, Payout reserves, Platform Fees, and provider clearing. It is an internal subledger, not the university or corporate general ledger.
