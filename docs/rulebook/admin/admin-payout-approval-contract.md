# Admin Payout Approval Contract

Part of the [Admin Rulebook](admin-rulebook.md). Defines accepted policy for manual Admin review and approval of Member Payout requests.

## Workflow and review queue

Fully specified by `docs/adr/0022-manual-admin-approval-for-payouts.md` and `docs/adr/0008-encrypt-payout-destination-secrets.md`.

- Submitted Payouts enter the Admin review queue with status `PENDING_ADMIN_APPROVAL`.
- The Admin API provides review queue listing, Payout details, status history, approval, and cancellation under `/api/v1/admin/payouts`, protected by Admin session authentication.

## Security and masked display

- Payout destination details (bank account numbers, routing info) are stored encrypted with AES-256-GCM.
- Admin UI and API responses show only masked display values. Raw decrypted credentials are used exclusively by the provider worker adapter.

## Decisions and provider hand-off

- **Approve**: Commits the approval record in the database, transitioning the Payout to provider-processing. A background Payout worker then initiates the transfer with the external provider.
- **Cancel**: Releases held reserves back to the Member's Earnings Balance with an immutable reversing Ledger Transaction (ADR 0010).
- All decisions require an `Idempotency-Key`, a numeric `If-Match` Payout version, and a controlled `reasonCode`. Admin Action reason catalog version `2` defines the action-specific codes:
  - `PAYOUT_APPROVE`: `PAYOUT_DESTINATION_VERIFIED`, `PAYOUT_ACCOUNT_OWNER_MATCHED`, `PAYOUT_POLICY_CHECK_PASSED`, or `PAYOUT_RISK_REVIEW_CLEARED`.
  - `PAYOUT_CANCEL`: `PAYOUT_INVALID_DESTINATION`, `PAYOUT_ACCOUNT_OWNER_MISMATCH`, `PAYOUT_POLICY_CHECK_FAILED`, `PAYOUT_RISK_REVIEW_FAILED`, or `PAYOUT_REQUIRED_INFORMATION_MISSING`.
- The Admin UI `Reject` decision maps to API `cancel`. It is not a separate outcome. Cancellation releases the full Payout Reserve.
- Version-1 Admin Actions remain readable with their recorded catalog version and reason code. The Server records each new immutable Admin Action and Payout change in one transaction. A successful command returns the updated Payout summary, its new `resourceVersion`, and the `adminActionId`.
- An Admin may provide an optional `decisionReasonText` of 1 to 200 characters with at least one non-whitespace character. The note is stored separately on the immutable Admin Action, is available only through the enabled-Admin Activity Log, is not part of Member-facing Payout data or the Provider request, and does not change the Payout Reserve release behavior.
- Once decided, the Admin decision is final and provider webhooks own subsequent status transitions.
