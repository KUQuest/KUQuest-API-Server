# Finance and Wallet Target Spec

Type: Rulebook
Status: accepted
Domain: Finance and Wallets
Authority: Defines accepted Student Wallet, double-entry ledger, Funding Reservation, Earnings Conversion, Payout, and Money Policy policy. Overrides Legacy Implementation in this domain.
Approved by: Domain Owner
Approved at: 2026-08-31

This document and its disclosed sub-contracts define the accepted target behavior for Student Wallets, integer-satang double-entry bookkeeping, Quest Escrow Funding Reservations, Top-ups, Earnings Conversions, Payouts, and versioned Money Policies.

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

The Finance domain covers six functional areas:

- **Student Wallets**: 4 distinct balance compartments with overflow safeguards up to 2,000,000,000 Satang (฿20M).
- **Double-Entry Ledger**: Balanced, sealed, and immutable double-entry subledger tracking 6 account types and 7 event types.
- **Funding Reservations**: Generic Escrow hold/settle/release mechanism decoupled from the Quest domain, with a 7-day failure hold.
- **Top-up Flow**: PromptPay QR deposits with 5-minute quote lifetimes and automated webhook clearing.
- **Earnings Conversion**: Instant, fee-free transfer from Earnings to Spending balance.
- **Payout Management**: Application-layer encrypted destination storage (AES-256-GCM), masked display, and manual Admin review queues.
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

## Sub-contracts (Disclosed Reference)

Follow the context pointer for the finance branch being planned or implemented:

| Branch / Area | Topic and triggers | Sub-contract file |
| --- | --- | --- |
| **Wallet Compartments & Limits** | 4 balance compartments, integer Satang representation, 2B Satang capacity cap, `ACTIVE`/`FROZEN`/`SUSPENDED`/`CLOSED` status permissions. | [wallet-compartment-contract.md](wallet-compartment-contract.md) |
| **Double-Entry Ledger** | Authoritative balanced double-entry subledger, zero-sum posting invariant, 6 account types, sealed transactions, reversing transactions. | [double-entry-ledger-contract.md](double-entry-ledger-contract.md) |
| **Funding Reservations** | Generic caller-scoped reservations, atomic publish Escrow lock, per-slot settlement, release, 7-day failure money hold. | [funding-reservation-contract.md](funding-reservation-contract.md) |
| **Top-up & Conversion** | PromptPay QR quote generation, webhook processing, instant fee-free Earnings to Spending conversions, idempotency. | [topup-and-conversion-contract.md](topup-and-conversion-contract.md) |
| **Payouts & Destinations** | AES-256-GCM encrypted bank details, masked display, manual Admin approval queue (`PENDING_ADMIN_APPROVAL`), provider worker hand-off. | [payout-contract.md](payout-contract.md) |
| **Money Policy** | Versioned policy revisions, Platform Fee calculation (`platformFeeBps`), ceiling rounding (`feeRoundingMode = 'UP'`), min/max transaction amounts. | [money-policy-contract.md](money-policy-contract.md) |

## Scope boundaries & deferred capabilities

- **Internal Subledger Only (ADR 0012)**: The ledger proves Student Wallet balances and platform fees; it does not replace external general accounting or tax reporting systems.
- **No Direct Peer-to-Peer Transfers**: Money moves only through funded Quests, Top-ups, Conversions, or Payouts. Direct user-to-user transfers outside Quests are not supported.
- **Conversion Irreversibility**: Funds converted from `EARNINGS` to `SPENDING` cannot be converted back to `EARNINGS`.
- **Manual Payout Gate (ADR 0022)**: No Payout is processed automatically without prior Admin approval.
