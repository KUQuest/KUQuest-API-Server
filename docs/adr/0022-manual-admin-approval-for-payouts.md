# Require manual Admin approval for every Payout

Every Member-initiated Payout requires an explicit Admin decision before KUQuest calls the Payout provider. The Payout Reserve is created when the Member submits the Payout, so the reserved funds are unavailable for another Payout or Earnings Conversion while the Payout waits for review.

The Payout uses `PENDING_ADMIN_APPROVAL` while it waits. The Member can see this status in Payout detail and list responses. No provider call occurs in this status.

The Member cannot cancel a Payout. Only an Admin can cancel it while it waits for Admin approval, and that cancellation releases the Payout Reserve.

`PENDING_ADMIN_APPROVAL` is an active Payout status. A Member cannot create another Payout while any Payout is in this status or in the existing provider-processing statuses.

If the provider rejects or fails a Payout after Admin approval, the existing provider outcome flow remains in control: the Payout is marked failed, the full Payout Reserve is released to the Member's Earnings Balance, and the provider outcome is retained.

Admin Payout detail may show the Member, amount, fees, tax, bank name, destination type, masked destination value, status, history, and cancellation reason. It must not show plaintext bank account numbers, encrypted destination payloads, provider secrets, or raw provider payloads.

Admin approval and cancellation require an `Idempotency-Key`. A retry returns the same decision result and cannot submit a Payout to the provider twice or release the Payout Reserve twice.

The Admin review queue lists `PENDING_ADMIN_APPROVAL` Payouts by default. It supports cursor pagination, newest or oldest sorting, and an optional status filter for historical Payouts.

After approval, a dedicated Payout worker claims the approved Payout, calls the provider outside a database transaction, and leaves webhook and reconciliation processing unchanged. The worker is deployed as a separate staging process.

The Admin API provides a review queue, Payout detail, status history, approval, and cancellation under `/api/v1/admin/payouts`, protected by the existing Admin session guard. Admin decisions use idempotency so a retry cannot call the provider twice or release funds twice. An Admin can decide only while the Payout waits for approval. After approval, the decision is final and the provider flow owns the next status.

The approval endpoint records the decision and commits it. A Payout worker calls the provider after approval, outside the database transaction. This gives the approved Payout a durable hand-off if the API process stops after the Admin decision.

An Admin can approve the Payout, which allows the existing provider flow to continue, or cancel the Payout, which releases the full Payout Reserve back to the Member's Earnings Balance in a sealed Ledger Transaction. A cancellation requires a non-empty reason. An approval may include an optional note. The decision and the release are recorded together with the Admin actor. There is no automatic cancellation or release after a time limit; an Admin must approve or cancel every Payout.

This keeps the provider call behind a manual control point and makes the return of funds auditable. It also means a Payout can remain waiting for Admin action until an Admin handles it.
