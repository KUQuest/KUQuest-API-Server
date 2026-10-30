# Admin Dispute Case Contract

Part of the [Admin Rulebook](admin-rulebook.md). Defines accepted policy for Dispute Cases on `QUEST_FAILED` Quests, filing content, respondent statements, the 7-day money hold, filing windows, and Satang redirection.

## Scope and purpose

A Dispute Case reverses part of the automatic settlement a `QUEST_FAILED` Quest already applied (unpaid Worker-slot funding returning to the Hirer), when that settlement was unfair to a specific Worker.

## Structural constraints

- **Multiple filers**: A Quest may have more than one Dispute Case, at most one per filer (the Hirer, or a Worker who held an Assignment on that Quest). On a `GROUP + CANDIDATE` Quest the only Worker filer is the Team Leader (see Team Dispute Case).
- **Candidate Team filer**: In `GROUP + CANDIDATE`, only the Team Leader can file for the Team, because the Team has one outcome. The Server refuses a teammate's filing with `403 DISPUTE_CASE_TEAM_LEADER_ONLY`, also when an Admin opens the case on that teammate's behalf.
- **Per-Quest shared cap**: The total Satang redirected across all of a Quest's Dispute Cases must never exceed what remains in that Quest's held Funding Reservation. The cap starts as the amount returned to the Hirer at failure settlement and shrinks if a post-failure Proof approval settles a Reward first.
- **One-way money flow**: Money moves exclusively Hirer &rarr; Worker. A Dispute Case can never reclaim a Reward already transferred directly to a Worker before the Quest failed.
- **Failed Quest scope**: A `QUEST_CANCELLED` Quest has no Dispute Case path.
- **Partial result scope**: A `GROUP + FIRST_COME_FIRST_SERVED` Quest that ends as `QUEST_COMPLETED` with at least one `ASSIGNMENT_INCOMPLETE` Assignment also has a Dispute Case path. It follows the same rules as `QUEST_FAILED`. Every window and hold in this contract starts when the Quest becomes terminal (`QUEST_COMPLETED` or `QUEST_FAILED`). The returning funding is not in the hold before that time, so a Dispute Case cannot redirect it earlier.

## Team Dispute Case (`GROUP + CANDIDATE`)

See [ADR 0036](../../adr/0036-team-dispute-case-payout-split.md).

- **One filer**: Only the Team Leader of the selected Candidate Team files the Dispute Case for the whole team. The case stores the `teamId` and covers every team member. A team member who is not the Team Leader cannot file (`DISPUTE_CASE_TEAM_LEADER_ONLY`). An Admin who opens a case for the team uses the Team Leader as the filer. The filing windows do not change.
- **Admin decision**: For a team case, `DISPUTE_CASE_RESOLVED` carries only a positive `amountSatang`. The amount must not be more than what the hold can still pay after the other unpaid team approvals of the Quest (`DISPUTE_CASE_AMOUNT_EXCEEDS_HOLD`). The decision moves no money. The case records the Team Leader as `resolvedWorkerId`.
- **Split deadline**: The Team Leader has 24 hours after the decision to confirm the split.
- **Split content**: The split lists every team member, the Team Leader included, once. Each share is an integer in basis points (0 to 10000), and the shares total 10000. A confirmed split is immutable and its command is idempotent.
- **Rounding**: Each amount rounds down. The remaining Satang go one by one to the largest fractional remainders. A tie goes to the earlier team member. The amounts total the approved amount exactly.
- **No split in time**: The Server splits the amount equally with the same rounding and pays.
- **Payment**: After the split is confirmed, the Server pays each member with one Wallet Dispute settlement. The settlement reference is `dispute-team-split:{allocationId}:{memberId}`. The Server stores the Ledger Transaction id and `paidAt` on the member row as payment evidence. A member with 0 Satang has no payment.
- **Hold and balance check**: Before the first payment, the Server checks that the hold can pay the whole split. After the hold released, it checks the remaining Quest cap and the Hirer's Spending Balance. If the check fails, nobody is paid. The split stays confirmed with a `paymentFailureCode` and the worker retries.
- **Hold pause**: The day-7 hold release skips a Quest that has an unpaid team split.
- **Visibility**: The Quest `dispute` object has `viewerRole`, `teamCase`, and `teamSplit`. `canFile` is false for a `TEAM_MEMBER`. `GET` and `POST /api/v1/quests/:questId/disputes/team-split` read and confirm the split. Only team members can read it.

## Filing windows

- **Self-file window (Hirer / Worker)**: Within **1 day** of the Quest becoming `QUEST_FAILED`.
- **Admin-filed window (on Worker's behalf)**: Within **5 days** of the Quest becoming `QUEST_FAILED`. An Admin-opened case counts toward the same per-Quest cap.
- **Admin Review Item relationship**: An Admin needs no Admin Review Item to open a case. An Admin Review Item is an automatic audit record for `PROOF_NOT_APPROVED`; it is not a Dispute Case.

## Filing content and case response

Every filing requires a `category` and `submittedDetail`.

The allowed `category` values are:

- `PROOF_REVIEW`: the filing concerns review of a Proof Submission.
- `QUEST_CONDITION`: the filing says the Worker met the Quest Condition.
- `PARTIAL_WORK`: the filing asks for a Reward for part of the work.
- `OTHER`: the filing has another basis.

The filing Member selects the category and provides `submittedDetail` when filing a Case. For an Admin-filed Case, the Worker selects the category and provides `submittedDetail`; the Admin submits the Worker's values. The Admin does not write either value as if it came from the Worker.

`filerStatement` is optional and must come from the filing Member. For an Admin-filed Case, the Worker provides the statement and the Admin submits it. The Admin does not write a statement as if it came from the Worker.

The opposing Member may submit an optional `respondentStatement` directly by calling `POST /api/v1/disputes/:disputeCaseId/respond`. The route accepts a response only while the Quest is `QUEST_FAILED` and the Dispute Case is `DISPUTE_CASE_PENDING`. The response must be submitted no later than 7 days after the Quest became `QUEST_FAILED`. If the Case remains pending and the respondent submits no statement by that deadline, the Admin may still review and decide the Case.

The filing `category` is separate from the Admin decision `reasonCode`. The category describes the basis of the filing. The reason code records the Admin's finding.

## 7-Day money hold

- When a Quest becomes `QUEST_FAILED`, or becomes `QUEST_COMPLETED` with at least one `ASSIGNMENT_INCOMPLETE` Assignment, the returned funding is held for **7 days** in the Quest's Funding Reservation (kept `ACTIVE` with remaining Satang), not released as ordinary Spending Balance.
- The hold includes the returning Platform Fee; the reservation is not split.
- Post-failure Proof approvals settle from this held reservation.
- The hold releases automatically 7 days after `QUEST_FAILED`. The only pause is an unpaid team split (see Team Dispute Case).
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
