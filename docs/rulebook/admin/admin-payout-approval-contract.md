# Admin Payout Approval Contract

Part of the [Admin Rulebook](admin-rulebook.md). Defines accepted policy for manual Admin review and approval of Student Payout requests.

## Workflow and review queue

Fully specified by `docs/adr/0022-manual-admin-approval-for-payouts.md` and `docs/adr/0008-encrypt-payout-destination-secrets.md`.

- Submitted Payouts enter the Admin review queue with status `PENDING_ADMIN_APPROVAL`.
- The Admin API provides review queue listing, Payout details, status history, approval, and rejection under `/api/v1/admin/payouts`, protected by Admin session authentication.

## Security and masked display

- Payout destination details (bank account numbers, routing info) are stored encrypted with AES-256-GCM.
- Admin UI and API responses show only masked display values. Raw decrypted credentials are used exclusively by the provider worker adapter.

## Decisions and provider hand-off

- **Approve**: Commits the approval record in the database, transitioning the Payout to provider-processing. A background Payout worker then initiates the transfer with the external provider.
- **Reject**: Releases held reserves back to the Student's Earnings Balance with an immutable reversing Ledger Transaction (ADR 0010).
- All decisions require `Idempotency-Key` to ensure retries do not double-initiate provider transfers or double-release funds.
- Once decided, the Admin decision is final and provider webhooks own subsequent status transitions.
