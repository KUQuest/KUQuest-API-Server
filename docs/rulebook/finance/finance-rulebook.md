# Finance and Wallet Target Spec

Type: Rulebook
Status: accepted
Domain: Finance and Wallets
Authority: Defines accepted Member Wallet, double-entry ledger, Funding Reservation, Earnings Conversion, Payout, and Money Policy policy. Overrides Legacy Implementation in this domain.
Approved by: Domain Owner
Approved at: 2026-08-31

This document and its disclosed sub-contracts define the accepted target behavior for Member Wallets, integer-satang double-entry bookkeeping, Quest Escrow Funding Reservations, Top-ups, Earnings Conversions, Payouts, and versioned Money Policies.

## Read first

1. Read the root `CONTEXT.md` for canonical financial vocabulary (`Wallet`, `Spending Balance`, `Earnings Balance`, `Funding Reservation`, `Top-up`, `Payout`, `Earnings Conversion`, `Platform Fee`).
2. Read the financial architecture decisions:
   - `docs/adr/0005-integer-satang-for-money.md`
   - `docs/adr/0006-ledger-is-financial-source-of-truth.md`
   - `docs/adr/0007-money-behavior-lives-behind-services.md`
   - `docs/adr/0008-encrypt-payout-destination-secrets.md`
   - `docs/adr/0009-keep-money-independent-of-quest-model.md`
   - `docs/adr/0010-retain-and-correct-financial-records.md`
   - `docs/adr/0012-wallet-ledger-is-a-subledger.md`
   - `docs/adr/0022-manual-admin-approval-for-payouts.md`
   - `docs/adr/0024-hold-quest-failure-settlement-for-dispute-window.md`
3. Treat this document and its sub-contracts as the authoritative financial contract alongside `docs/rulebook/quest/quest-work-chat-rulebook.md` and `docs/rulebook/admin/admin-rulebook.md`.

## Scope

The Finance domain covers seven functional areas:

- **Member Wallets**: 4 distinct balance compartments with overflow safeguards up to 2,000,000,000 Satang (฿20M).
- **Double-Entry Ledger**: Balanced, sealed, and immutable double-entry subledger tracking 6 account types and 7 event types.
- **Funding Reservations**: Generic Escrow hold/settle/release mechanism decoupled from the Quest domain, with a 7-day failure hold.
- **Top-up Flow**: PromptPay deposits using a binding Provider Quote, 5-minute confirmation lifetime, and automated webhook clearing.
- **Earnings Conversion**: Instant, fee-free transfer from Earnings to Spending balance.
- **Payout Management**: Thai bank account destinations with application-layer encryption (AES-256-GCM), masked display, binding Provider Quotes, and manual Admin review queues.
- **Money Policy**: Versioned fee structures, rounding modes, and operational limit controls.

## State and status naming

Every financial status adheres to the entity-prefix and canonical naming conventions:

| Object | Field | Allowed values |
| --- | --- | --- |
| Wallet | `walletStatus` | `ACTIVE`, `FROZEN`, `SUSPENDED`, `CLOSED` |
| Ledger Account | `type` | `SPENDING`, `EARNINGS`, `FUNDING_RESERVED`, `RESERVED_FOR_PAYOUTS`, `PLATFORM_REVENUE`, `PLATFORM_SUSPENSE` |
| Ledger Transaction | `eventType` | `TOP_UP`, `PAYOUT`, `FUNDING_RESERVE`, `FUNDING_RELEASE`, `FUNDING_SETTLEMENT`, `ADJUSTMENT`, `EARNINGS_CONVERSION` |
| Funding Reservation | `status` | `ACTIVE`, `RELEASED`, `SETTLED` |
| Payout | `status` | `PENDING_ADMIN_APPROVAL`, `SUBMITTED_TO_PROVIDER`, `PROVIDER_PENDING`, `SUCCEEDED`, `FAILED`, `CANCELLED` |

## Provider Quote and external provider rules

- `Top-up` and `Payout` require a binding **Provider Quote** before the Member confirms the operation.
- The Provider Quote supplies the Provider fee and tax for that operation. `Money Policy` supplies limits, Platform Fee rules, rounding rules, and the Quote lifetime; it is not a fallback for a missing Provider fee or tax.
- The Quote lifetime is 300 seconds (5 minutes) before confirmation. After confirmation, the Server stores an immutable Quote Snapshot for the operation. Quote expiry does not change that Snapshot.
- A Quote is single-use. A retry with the same Idempotency-Key returns the same operation; a new operation requires a new Quote.
- If the Provider cannot return a valid binding Quote, the Server must not create a Payment Request, create a Payout Reserve, or post a financial Ledger transaction.
- After submission, a Provider Timeout, missing callback, or amount mismatch has no immediate Wallet effect. The operation remains pending for Provider Callback or Reconciliation.
- A Top-up credits `Spending Balance` only when the confirmed Provider amount exactly equals the quoted payment total. A Payout never debits more than the quoted maximum debit. A lower actual Payout debit releases the unused reserve to `Earnings Balance`; a higher debit remains pending for Reconciliation.
- The Provider adapter must prove that the selected Provider supports this binding-quote flow before production use. Adapter Unit Tests do not prove live Provider capability.

## Sub-contracts (Disclosed Reference)

Follow the context pointer for the finance branch being planned or implemented:

| Branch / Area | Topic and triggers | Sub-contract file |
| --- | --- | --- |
| **Wallet Compartments & Limits** | 4 balance compartments, integer Satang representation, 2B Satang capacity cap, `ACTIVE`/`FROZEN`/`SUSPENDED`/`CLOSED` status permissions. | [wallet-compartment-contract.md](wallet-compartment-contract.md) |
| **Double-Entry Ledger** | Authoritative balanced double-entry subledger, zero-sum posting invariant, 6 account types, sealed transactions, reversing transactions. | [double-entry-ledger-contract.md](double-entry-ledger-contract.md) |
| **Funding Reservations** | Generic caller-scoped reservations, atomic publish Escrow lock, per-slot settlement, release, 7-day failure money hold. | [funding-reservation-contract.md](funding-reservation-contract.md) |
| **Top-up & Conversion** | Binding Provider Quotes, PromptPay payment requests, exact-amount webhook clearing, instant fee-free Earnings to Spending conversions, and idempotency. | [topup-and-conversion-contract.md](topup-and-conversion-contract.md) |
| **Payouts & Destinations** | Thai bank account destinations, AES-256-GCM encryption, masked display, binding Provider Quotes, manual Admin approval queue (`PENDING_ADMIN_APPROVAL`), and provider worker hand-off. | [payout-contract.md](payout-contract.md) |
| **Money Policy** | Versioned policy revisions, Platform Fee calculation (`platformFeeBps`), ceiling rounding (`feeRoundingMode = 'UP'`), min/max transaction amounts, and Quote lifetime. | [money-policy-contract.md](money-policy-contract.md) |

## Scope boundaries & deferred capabilities

- **Internal Subledger Only (ADR 0012)**: The ledger proves Member Wallet balances and platform fees; it does not replace external general accounting or tax reporting systems.
- **No Direct Peer-to-Peer Transfers**: Money moves only through funded Quests, Top-ups, Conversions, or Payouts. Direct user-to-user transfers outside Quests are not supported.
- **Conversion Irreversibility**: Funds converted from `EARNINGS` to `SPENDING` cannot be converted back to `EARNINGS`.
- **Manual Payout Gate (ADR 0022)**: No Payout is processed automatically without prior Admin approval.
