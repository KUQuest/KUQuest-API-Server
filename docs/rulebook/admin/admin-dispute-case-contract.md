# Admin Dispute Case Contract

Part of the [Admin Rulebook](admin-rulebook.md). Defines accepted policy for Dispute Cases on `QUEST_FAILED` Quests, the 7-day money hold, filing windows, and Satang redirection.

## Scope and purpose

A Dispute Case reverses part of the automatic settlement a `QUEST_FAILED` Quest already applied (unpaid Worker-slot funding returning to the Hirer), when that settlement was unfair to a specific Worker.

## Structural constraints

- **Multiple filers**: A Quest may have more than one Dispute Case, at most one per filer (the Hirer, or a Worker who held an Assignment on that Quest).
- **Per-Quest shared cap**: The total Satang redirected across all of a Quest's Dispute Cases must never exceed what remains in that Quest's held Funding Reservation. The cap starts as the amount returned to the Hirer at failure settlement and shrinks if a post-failure Proof approval settles a Reward first.
- **One-way money flow**: Money moves exclusively Hirer &rarr; Worker. A Dispute Case can never reclaim a Reward already transferred directly to a Worker before the Quest failed.
- **Failed Quest scope**: A `QUEST_CANCELLED` Quest has no Dispute Case path.

## Filing windows

- **Self-file window (Hirer / Worker)**: Within **1 day** of the Quest becoming `QUEST_FAILED`.
- **Admin-filed window (on Worker's behalf)**: Within **5 days** of the Quest becoming `QUEST_FAILED`. An Admin-opened case counts toward the same per-Quest cap.
- **Admin Review Item relationship**: An Admin needs no Admin Review Item to open a case. An Admin Review Item is an automatic audit record for `PROOF_NOT_APPROVED`; it is not a Dispute Case.

## 7-Day money hold

- When a Quest becomes `QUEST_FAILED`, the returned funding is held for **7 days** in the Quest's Funding Reservation (kept `ACTIVE` with remaining Satang), not released as ordinary Spending Balance.
- The hold includes the returning Platform Fee; the reservation is not split.
- Post-failure Proof approvals settle from this held reservation.
- The hold releases automatically and unconditionally 7 days after `QUEST_FAILED`.
- If a Dispute Case resolves after the hold has released, funds come from the Hirer's Spending Balance; if insufficient, the transfer fails.

## Decision and settlement

- Admin resolves a Dispute Case as:
  - `DISPUTE_CASE_DISMISSED`: No money movement; case closes.
  - `DISPUTE_CASE_RESOLVED`: An explicit positive Satang amount is redirected to the named Worker's Earnings Balance as a reversing Ledger Transaction.
- Each decision requires a controlled `reasonCode` and a non-blank `Idempotency-Key`.
- An Admin may also provide an optional `decisionReasonText` of 1 to 200 characters with at least one non-whitespace character.
- The note is stored separately on the immutable Admin Action and is visible only to enabled Admins through the Activity Log. It does not replace `reasonCode` or appear in Member notifications.
- The first confirmed decision is final and creates an Audit Record.
- A non-active Hirer Wallet (`FROZEN`, `SUSPENDED`, `CLOSED`) does not block the redirect.

## Decision reason catalog

Admin Action reason catalog version `2` defines the action-specific reason codes:

`DISPUTE_CASE_DISMISS` accepts:

- `DISPUTE_INSUFFICIENT_EVIDENCE`
- `DISPUTE_QUEST_RECORD_DOES_NOT_SUPPORT_CLAIM`
- `DISPUTE_NO_UNFAIR_SETTLEMENT_FOUND`
- `DISPUTE_WORKER_ALREADY_COMPENSATED`

`DISPUTE_CASE_RESOLVE` accepts:

- `DISPUTE_VALID_PROOF_NOT_APPROVED`: the Proof Submission meets the Quest Condition, but the Hirer did not approve it.
- `DISPUTE_WORKER_MET_QUEST_CONDITION`: Quest records show the Worker met the agreed condition, but failure settlement returned the slot funds to the Hirer.
- `DISPUTE_PARTIAL_WORK_EARNED_REWARD`: evidence supports payment for part of the work, so the Admin redirects the matching Satang amount.

The Admin selects `reasonCode`; the Server does not derive it from the outcome.
The code records the Admin's finding. It does not calculate the redirect amount
or change the accepted settlement. Version-1 Admin Actions remain readable with
their recorded catalog version and code.

An Admin may also provide an optional `decisionReasonText` of up to 200
characters. The note is stored separately on the immutable Admin Action and
does not replace `reasonCode` or change the money movement.
