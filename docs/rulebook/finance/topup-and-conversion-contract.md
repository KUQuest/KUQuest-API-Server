# Top-up and Earnings Conversion Contract

Part of the [Finance Rulebook](finance-rulebook.md). Defines accepted policy for Member Top-ups, Provider Quotes, PromptPay payment provider integration, quote lifetimes, and fee-free Earnings Conversions.

## 1. Top-up flow

Top-up allows a Member to add the quoted credit amount to their `SPENDING` balance through a PromptPay payment request.

### Provider Quote and payment lifecycle

1. **Quote Request**: The Member requests a credit amount in Baht (&ge; `minimumTopUpSatang`, &le; `maximumTopUpSatang`). The Server converts the amount to integer Satang.
2. **Provider Quote**: The Server asks the Provider for a binding Quote. The Quote contains `creditSatang`, `chargedFeeSatang`, `chargedTaxSatang`, `paymentTotalSatang`, and an expiry timestamp. The Provider sets the fee and tax for this operation; the Server does not guess them from `Money Policy`.
3. **Member Confirmation**: The Server shows the credit amount, Provider fee, tax, and payment total. The Member must confirm before the Quote expires. An expired Quote cannot be confirmed.
4. **Payment Request**: After confirmation, the Server consumes the single-use Quote and creates the PromptPay Payment Request for the exact `paymentTotalSatang`. It then returns the payment instructions or QR data to the Member.
5. **Payment & Webhook**: The Member pays through mobile banking. The Provider sends an authenticated webhook. The Server stores the event durably, processes it asynchronously, and uses the same Idempotency-Key for retries.
6. **Exact-amount clearing**: The Server credits `Spending Balance` only when the confirmed Provider amount exactly equals `paymentTotalSatang`. It records a `TOP_UP` Ledger transaction from `PLATFORM_SUSPENSE` to the Member's `SPENDING` account.
7. **Mismatch or uncertainty**: A missing amount, amount mismatch, Provider Timeout, or missing callback does not credit the Wallet. The Top-up remains pending or in `PLATFORM_SUSPENSE` for Reconciliation. The Server does not treat an underpayment as a fee or an overpayment as automatic credit.
8. **Capacity Check**: If the Top-up would cause the Wallet to exceed the 2,000,000,000 Satang capacity cap, the transaction fails closed without creating the credit Ledger transaction.

### Quote failure and idempotency rules

- If the Provider cannot return a valid binding Quote, the Server does not create a Payment Request, change a Wallet, or post a Ledger transaction.
- The Quote lifetime is 300 seconds (5 minutes) before Member confirmation. After confirmation, the Server keeps an immutable Quote Snapshot for the Top-up even if the original Quote expiry time passes.
- One Provider Quote is valid for one Top-up only. A repeated request with the same Idempotency-Key returns the existing Top-up; a new request requires a new Quote.
- A Provider Timeout or missing callback remains pending until a Provider Callback or Reconciliation proves the result. The Server does not reverse or credit an uncertain result automatically.
- The Provider adapter must support a binding pre-payment Quote. A Provider integration that only accepts a requested amount and reports fees later cannot satisfy this Top-up contract.

---

## 2. Earnings Conversion flow

Earnings Conversion allows a Member to instantly transfer accumulated Quest Rewards from their `EARNINGS` balance into their `SPENDING` balance.

### Rules and constraints

- **Fee-Free**: Conversions are completely free of charge; no Platform Fee or processing fee is deducted.
- **Instant Execution**: The transfer executes immediately within a single database transaction.
- **Irreversible**: Once converted from Earnings to Spending, funds cannot be converted back to Earnings.
- **Minimum Amount**: Must be at least `minimumEarningsConversionSatang` (default 100 Satang / ฿1).
- **Ledger Posting**: Creates an `EARNINGS_CONVERSION` ledger transaction:
  - Debit (+) `SPENDING` balance
  - Credit (-) `EARNINGS` balance
- **Audit Record**: Every conversion writes an immutable audit record in `wallet_earnings_conversions` linked to the ledger transaction and `Idempotency-Key`.
- **Status Check**: Blocked if the Member's Wallet is `FROZEN`, `SUSPENDED`, or `CLOSED`.
