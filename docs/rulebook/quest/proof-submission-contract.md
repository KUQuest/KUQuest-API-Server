# Proof Submission and Review Contract

Part of the [Quest and Work Chat Rulebook](quest-work-chat-rulebook.md). Defines accepted policy for Proof Submission drafts, uploads, Hirer review, auto-approval, non-approval failure, and Admin Review Items.

## Proof requirement paths

- **When `proofRequired=false`**: The required work submitter confirms completion before `dueAt`. No Proof Submission is created and no Hirer review is required.
  - `SINGLE`: Worker confirms.
  - `GROUP + FCFS`: Every Active Worker confirms.
  - `GROUP + CANDIDATE`: Team Leader confirms the Team's work.
- **When `proofRequired=true`**: The required work submitter submits proof before `dueAt` for Hirer review.

## Draft and send

- The required work submitter can save an unsent draft, edit it, delete it, and create a replacement draft before `dueAt`. A draft is visible only to that submitter and creates no System Message or notification.
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

## Failure and Admin Review Item

- A `PROOF_NOT_APPROVED` decision makes the Assignment `ASSIGNMENT_INCOMPLETE`, gives that Worker no Reward, and makes the Quest `QUEST_FAILED` immediately.
- The same decision creates exactly one **Admin Review Item** automatically. It links the Quest, Assignment, Proof Submission, Hirer, Worker, decision reason, and evidence references, sending it to the Admin review queue.
- The Admin Review Item is for review and audit only. It does not delay or undo `QUEST_FAILED`, reopen the Quest, create Rework, or allow a second Proof Submission.
- Notification failure does not undo `QUEST_FAILED`; retries reuse the same Item identity.
- A missing required submission at `dueAt` fails the Quest immediately.

## Post-failure review and partial success

- If another Worker has a Proof Submission sent on time and still `PROOF_PENDING`, the Hirer may review it after the Quest becomes `QUEST_FAILED`.
- If that later review approves the submission, its Assignment becomes `ASSIGNMENT_COMPLETED` and its Worker receives the Reward from the held Funding Reservation (see [Reward & Money Contract](reward-money-contract.md)). The Quest remains `QUEST_FAILED`.
- In a `GROUP + FCFS` Quest, an approved or proof-free completed Worker keeps the Reward even when another Worker later causes `QUEST_FAILED`.
