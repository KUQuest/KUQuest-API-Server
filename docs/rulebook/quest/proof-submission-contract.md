# Proof Submission and Review Contract

Part of the [Quest and Work Chat Rulebook](quest-work-chat-rulebook.md). Defines accepted policy for Proof Submission drafts, uploads, Hirer review, auto-approval, non-approval failure, and Admin Review Items.

## Proof requirement paths

- **When `proofRequired=false`**: The required work submitter creates a Completion Confirmation before `dueAt`. The Confirmation is a separate resource. The Server does not create a Proof Submission for it. The Hirer must approve or not approve the Confirmation.
  - `SINGLE`: Worker confirms.
  - `GROUP + FCFS`: Every Active Worker confirms.
  - `GROUP + CANDIDATE`: Team Leader confirms the Team's work.
- **When `proofRequired=true`**: The required work submitter submits proof before `dueAt` for Hirer review.

## Draft and send

- The required work submitter can save an unsent draft, edit it, delete it, and create a replacement draft before `dueAt`. A draft is visible only to that submitter and creates no System Message or notification.
- A create command replaces the submitter's own unsent draft in one transaction. A create command after the Proof Submission is sent returns `PROOF_SUBMISSION_ALREADY_EXISTS`.
- Description is optional and is at most 1,000 characters.
- The submitter can attach up to five files.
- Allowed file types are image, PDF, and video. Each file is at most 10 MB. The system does not scan files for malware. Other types are rejected.
- At least one description or file is required.
- Before sending, the Worker can add, remove, or replace files. After sending, the Proof Submission is locked.
- A successful partial upload stays in the draft. A failed file is identified and can be retried or removed. Sending is blocked while a failed file remains.
- If the device is offline, sending is shown as failed and the draft remains available. The Worker must retry manually. `dueAt` remains authoritative.

## Review and decision

- Decision status is `PROOF_PENDING`, `PROOF_APPROVED`, or `PROOF_NOT_APPROVED`. There is no `PROOF_REJECTED` status.
- The Hirer reviews one Proof Submission at a time. Batch decisions are not available.
- The Hirer review list is grouped by Assignment, with `PROOF_PENDING` first.
- A KU bot or Push action opens the review Popup with details, evidence, and actions.
- The Hirer must confirm an approval or non-approval in a Popup. Closing without a decision leaves the status `PROOF_PENDING`.
- `PROOF_NOT_APPROVED` requires a reason of at most 1,000 characters. The reason is visible to the Hirer, submitting Worker, and authorized Admins through the Admin Review Item. Other participants see only a summary.
- The first confirmed decision is final. Multiple Hirer devices use the first decision accepted by the Server.
- If no decision exists 24 hours after sending, the Server records `PROOF_APPROVED` automatically.

## Completion Confirmation review

- A Completion Confirmation has `COMPLETION_CONFIRMATION_PENDING`, `COMPLETION_CONFIRMATION_APPROVED`, `COMPLETION_CONFIRMATION_NOT_APPROVED`, or `COMPLETION_CONFIRMATION_CANCELLED` status. It has no Proof Submission, file, or evidence reference.
- The Hirer receives a notification when a Worker creates a Completion Confirmation. The notification includes its 24-hour `reviewDeadlineAt`.
- The Hirer reviews one Completion Confirmation at a time. The first final decision accepted by the Server wins.
- `COMPLETION_CONFIRMATION_NOT_APPROVED` requires a non-blank reason of at most 1,000 characters. The reason is visible to the Hirer and the Worker who submitted the Confirmation. Other Workers see a summary only.
- If the Hirer does not decide within 24 hours after `confirmedAt`, the Server records `COMPLETION_CONFIRMATION_APPROVED` automatically.
- The Worker who submitted the Confirmation receives a notification when the Hirer or Server records the decision.
- The Hirer and affected Workers receive real-time updates when the Confirmation becomes pending and when it receives a final decision.
- If the Hirer cancels the Quest or an Admin terminates it while a Confirmation is pending, the Server changes it to `COMPLETION_CONFIRMATION_CANCELLED`. Do not pay its Reward; return its unsettled Reward and Platform Fee to the Hirer. The affected Worker or selected Team member can read the cancelled Confirmation after cancellation. Other Members cannot read it.

## Failure and Admin Review Item

- A non-approval makes the affected Assignment `ASSIGNMENT_INCOMPLETE` and gives that Worker no Reward.
- In `SINGLE` (both modes) and `GROUP + CANDIDATE`, non-approval makes the Quest `QUEST_FAILED` immediately. In `GROUP + CANDIDATE`, every Active Worker Assignment becomes `ASSIGNMENT_INCOMPLETE` and receives no Reward.
- In `GROUP + FIRST_COME_FIRST_SERVED`, non-approval affects only that Worker's Assignment. Other Active Workers can still complete work. When every Assignment has a final result, the Quest becomes `QUEST_COMPLETED` if at least one Assignment is `ASSIGNMENT_COMPLETED`; otherwise, it becomes `QUEST_FAILED`.
- The non-approval creates exactly one **Admin Review Item** automatically. It links the Quest, affected Assignment, Hirer, Worker, reason, and either the Proof Submission with its evidence references or the Completion Confirmation with an empty evidence list.
- The Admin Review Item is for review and audit only. It does not delay or undo `QUEST_FAILED`, reopen the Quest, create Rework, or allow a second Proof Submission.
- Notification failure does not undo `QUEST_FAILED`; retries reuse the same Item identity.
- A missing required submission at `dueAt` fails the Quest immediately.

## Post-failure review and partial success

- If another Worker has a Proof Submission sent on time and still `PROOF_PENDING`, the Hirer may review it after the Quest becomes `QUEST_FAILED`.
- If that later review approves the submission, its Assignment becomes `ASSIGNMENT_COMPLETED` and its Worker receives the Reward from the held Funding Reservation (see [Reward & Money Contract](reward-money-contract.md)). The Quest remains `QUEST_FAILED`.
- A pending proof-free Completion Confirmation for a `GROUP + FIRST_COME_FIRST_SERVED` Quest can also be reviewed after the Quest becomes `QUEST_FAILED`. Approval settles the affected Worker's Reward. The Quest remains `QUEST_FAILED`.
- In a `GROUP + FCFS` Quest, an approved or proof-free completed Worker keeps the Reward even when another Worker later causes `QUEST_FAILED`.
