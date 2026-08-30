# Payout and Destination Contract

Part of the [Finance Rulebook](finance-rulebook.md). Defines accepted policy for Student Payout requests, encrypted bank destination storage, manual Admin approval, and external provider clearing.

## 1. Payout Destinations (ADR 0008)

- **AES-256-GCM Encryption**: Bank account numbers and routing details are encrypted at the application layer before database persistence (`wallet_payout_destinations`).
- **Encryption Metadata**: Each record carries `keyId`, `nonce`, `ciphertext`, and `authTag`.
- **Masked Display**: Outside of the background provider worker, all API endpoints and Admin UIs return only masked display strings (e.g., `xxx-x-xx123-x`). Raw account numbers are never exposed in logs or status histories.

---

## 2. Payout Lifecycle and States

```text
[Initiate Payout]
       │
       ▼
PENDING_ADMIN_APPROVAL ──(Admin Reject)──► REJECTED / RELEASED
       │                                  (Reversing Ledger Tx)
(Admin Approve)
       │
       ▼
SUBMITTED_TO_PROVIDER
       │
       ▼
PROVIDER_PENDING
       ├──(Success)──► SUCCEEDED (Funds Cleared)
       └──(Failure)──► FAILED (Reversing Ledger Tx)
```

### Steps and rules

1. **Request Submission**:
   - A Student with an `ACTIVE` Wallet requests a Payout from `earningsBalanceSatang` (&ge; `minimumPayoutSatang`).
   - The requested amount moves from `EARNINGS` to `RESERVED_FOR_PAYOUTS`.
   - The Payout record is created with status `PENDING_ADMIN_APPROVAL`.
2. **Manual Admin Approval (ADR 0022)**:
   - All Payouts require explicit Admin review under `/api/v1/admin/payouts`.
   - **Approve**: Commits the approval, updates status to `SUBMITTED_TO_PROVIDER`, and enqueues a job for the background provider worker.
   - **Reject**: Admin provides a mandatory reason; the Server executes a reversing ledger transaction, moving funds from `RESERVED_FOR_PAYOUTS` back to `EARNINGS`.
3. **Provider Execution and Clearing**:
   - The background Payout worker contacts the payment provider (e.g., Xendit) using decrypted destination credentials.
   - On provider success callback: The Server records a `PAYOUT` ledger transaction (`RESERVED_FOR_PAYOUTS` &rarr; `PLATFORM_SUSPENSE`), marks the Payout `SUCCEEDED`, and closes the reservation.
   - On provider failure: The Server records a reversing transaction back to `EARNINGS` and marks the Payout `FAILED`.
4. **Idempotency**: Every Payout request and Admin approval/rejection requires `Idempotency-Key` to prevent duplicate transfers.
