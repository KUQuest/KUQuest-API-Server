# Top-up and Earnings Conversion Contract

Part of the [Finance Rulebook](finance-rulebook.md). Defines accepted policy for Student Top-ups, payment provider integration, quote lifetimes, and fee-free Earnings Conversions.

## 1. Top-up flow

Top-up allows a Student to deposit funds into their `SPENDING` balance via PromptPay QR.

### Quote and payment lifecycle

1. **Quote Request**: The Student requests a Top-up amount in Baht (&ge; `minimumTopUpSatang`, &le; `maximumTopUpSatang`).
2. **Quote Generation**: The Server creates a provider quote with an expiration timestamp (`quoteLifetimeSeconds`, default 300s / 5 minutes) and PromptPay QR data.
3. **Payment & Clearing**: The Student pays via mobile banking.
4. **Provider Webhook**: The payment provider sends a signed webhook callback.
5. **Ledger Posting**: The Server validates the webhook with `Idempotency-Key`, records a `TOP_UP` ledger transaction (`PLATFORM_SUSPENSE` &rarr; Student `SPENDING`), and updates `spendingBalanceSatang`.
6. **Capacity Check**: If the Top-up would cause the Wallet to exceed the 2,000,000,000 Satang capacity cap, the transaction fails closed.

---

## 2. Earnings Conversion flow

Earnings Conversion allows a Student to instantly transfer accumulated Quest Rewards from their `EARNINGS` balance into their `SPENDING` balance.

### Rules and constraints

- **Fee-Free**: Conversions are completely free of charge; no Platform Fee or processing fee is deducted.
- **Instant Execution**: The transfer executes immediately within a single database transaction.
- **Irreversible**: Once converted from Earnings to Spending, funds cannot be converted back to Earnings.
- **Minimum Amount**: Must be at least `minimumEarningsConversionSatang` (default 100 Satang / ฿1).
- **Ledger Posting**: Creates an `EARNINGS_CONVERSION` ledger transaction:
  - Debit (+) `SPENDING` balance
  - Credit (-) `EARNINGS` balance
- **Audit Record**: Every conversion writes an immutable audit record in `wallet_earnings_conversions` linked to the ledger transaction and `Idempotency-Key`.
- **Status Check**: Blocked if the Student's Wallet is `FROZEN`, `SUSPENDED`, or `CLOSED`.
