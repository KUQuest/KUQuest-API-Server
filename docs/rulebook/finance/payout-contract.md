# Payout and Destination Contract

Part of the [Finance Rulebook](finance-rulebook.md). Defines accepted policy for Member Payout requests, Thai bank account destination storage, Provider Quotes, manual Admin approval, and external provider clearing.

## 1. Payout Destinations (ADR 0008)

- **Thai bank accounts only**: A Payout Destination is a Thai bank account. PromptPay is a Top-up payment method and is not a Payout Destination.
- **AES-256-GCM Encryption**: Bank account numbers and routing details are encrypted at the application layer before database persistence (`wallet_payout_destinations`).
- **Encryption Metadata**: Each record carries `keyId`, `nonce`, `ciphertext`, and `authTag`.
- **Masked Display**: Outside of the background provider worker, all API endpoints and Admin UIs return only masked display strings (e.g., `xxx-x-xx123-x`). Raw account numbers are never exposed in logs or status histories.
- **Retirement**: A Member has at most one active Payout Destination. Replacing or removing one retires it without erasing its historical association with prior Payouts.

---

## 2. Payout Quote and lifecycle

```text
[Request Provider Quote]
       │
       ▼
 [Member Confirms]
       │
       ▼
PENDING_ADMIN_APPROVAL ──(Admin Cancel)──► CANCELLED
       │                                  (Release Ledger Tx)
 (Admin Approves)
       │
       ▼
SUBMITTED_TO_PROVIDER
       │
       ▼
PROVIDER_PENDING
       ├──(Success)──► SUCCEEDED (Funds Cleared and unused reserve released)
       └──(Failure)──► FAILED (Payout Reserve released)
```

### Steps and rules

1. **Provider Quote**:
   - A Member with an `ACTIVE` Wallet requests a receipt amount in Baht (&ge; `minimumPayoutSatang`, &le; `maximumPayoutSatang`) for an active Thai bank account Payout Destination.
   - The Server asks the Provider for a binding Quote containing `receiptSatang`, `providerFeeSatang`, `providerTaxSatang`, and `maximumDebitSatang`.
   - `maximumDebitSatang` equals `receiptSatang + providerFeeSatang + providerTaxSatang`. The Provider Quote sets the Provider fee and tax for this operation; the Server does not use a `Money Policy` fee fallback.
2. **Member Confirmation and Reserve**:
   - The Server shows the receipt amount, Provider fee, tax, and maximum debit. The Member must confirm before the 300-second (5-minute) Quote expiry.
   - After confirmation, the Server consumes the single-use Quote, stores an immutable Quote and Payout Destination Snapshot, and creates the Payout.
   - The Server moves `maximumDebitSatang` from `EARNINGS` to `RESERVED_FOR_PAYOUTS` in one Ledger transaction. The Payout starts as `PENDING_ADMIN_APPROVAL`.
   - Quote expiry after confirmation does not change the stored Snapshot. Retiring the original Payout Destination later does not change the Snapshot.
3. **Manual Admin Approval (ADR 0022)**:
   - All Payouts require explicit Admin review under `/api/v1/admin/payouts`.
   - Only an Admin can cancel a Payout. The Member cannot cancel it.
   - An Admin can cancel only while the Payout is `PENDING_ADMIN_APPROVAL`. The Server records `CANCELLED` and releases the full `Payout Reserve` back to `EARNINGS` through a reversing Ledger transaction.
   - `Admin` cannot edit the Quote, amount, fee, tax, or Payout Destination Snapshot. If a change is needed, the Admin cancels the Payout and the Member creates a new Quote and Payout.
   - **Approve**: Commits the approval using the exact Snapshot, updates status to `SUBMITTED_TO_PROVIDER`, and enqueues a job for the background provider worker.
4. **Provider Execution and Clearing**:
   - The background Payout worker contacts the payment provider using decrypted destination credentials.
   - On Provider success, the Provider-reported receipt amount must equal `receiptSatang`. The Server settles the actual debit from `Payout Reserve` and records the external clearing in the `PAYOUT` Ledger transaction.
   - If the actual Provider fee or tax is lower than the Quote, the Server releases the unused reserve to `EARNINGS` through the Ledger. It never keeps the unused difference.
   - If the actual debit is higher than `maximumDebitSatang`, the Server does not debit extra and keeps the Payout `PROVIDER_PENDING` for Reconciliation.
   - On Provider failure, the Server records a reversing Ledger transaction that releases the full Payout Reserve to `EARNINGS` and marks the Payout `FAILED`.
   - A Provider Timeout or missing callback leaves the Payout `PROVIDER_PENDING`; it does not trigger an automatic release or a duplicate Provider call.
5. **Idempotency**: Payout Quote confirmation, Payout creation, Admin approval, Admin cancellation, Provider submission, and Provider event processing are Idempotent. A retry cannot submit twice, cancel twice, or release the Payout Reserve twice.

### Quote failure rule

- If the Provider cannot return a valid binding Quote, the Server does not create a Payout, reserve funds, or post a Ledger transaction.
- The Provider adapter must support a binding pre-submission Quote. A Provider that only reports the fee after the payout is submitted cannot satisfy this contract without a separate user re-confirmation step.
