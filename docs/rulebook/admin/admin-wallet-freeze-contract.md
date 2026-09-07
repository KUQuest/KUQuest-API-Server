# Admin Wallet Freeze and Suspend Contract

Part of the [Admin Rulebook](admin-rulebook.md). Defines accepted policy for Admin freezing, suspending, and lifting Student Wallet statuses.

## Statuses and blocked operations

- Admin may set a Student's Wallet status to `FROZEN` or `SUSPENDED`. Both operations require a non-empty reason and a non-blank `Idempotency-Key`.
- **Blocked operations**: A non-active Wallet (`FROZEN`, `SUSPENDED`, or `CLOSED`) blocks that Student from starting any new commitment:
  - Top-up
  - Payout request
  - Earnings Conversion
  - Publishing a new Quest
  - Joining or applying to any Quest as a Worker or Candidate
  - Creating or joining a Candidate Team

## In-progress commitments protected

- Every commitment that existed before the hold began continues to completion under its own rules:
  - A Quest Escrow already reserved
  - An Assignment already active
  - A Payout already `PENDING_ADMIN_APPROVAL` or later
- Non-active Wallets still receive or release money required to reconcile commitments already in progress.

## Discretionary vs automatic holds

- **Intent distinction**:
  - `FROZEN`: Temporary hold pending investigation.
  - `SUSPENDED`: Hold requiring explicit Admin review before lifting.
- **Discretionary hold lifting**: Admin lifts a discretionary hold by explicitly returning the Wallet status to `ACTIVE`. There is no automatic expiry.
- **Automatic Ban Freeze**: A Freeze applied automatically by a temporary Member Ban is non-discretionary; it returns to `ACTIVE` automatically when the ban expires. An Admin discretionary freeze is never cleared by an expiring ban.
