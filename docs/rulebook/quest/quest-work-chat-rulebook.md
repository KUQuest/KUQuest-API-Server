# Work Chat and Quest Workflow Target Spec

Type: Rulebook
Status: accepted
Domain: Quest and Work Chat
Authority: Defines accepted Quest and Work Chat policy and overrides Legacy Implementation in this domain. For shared flows, it owns Quest State and Assignment behavior; the Admin Rulebook owns Admin actions and timing.
Approved by: Domain Owner
Approved at: 2026-08-31

This document and its disclosed sub-contracts define the accepted target behavior for Candidate Inquiry Conversations, Work Chat, Quest Conditions, Quest Edits, Sent Work, Proof Submissions, Reviews, Notifications, and Reward flow.

## Read first

1. Read the root `CONTEXT.md` for the canonical vocabulary, then use this document and its sub-contracts for settled branch behavior.
2. Read `docs/adr/0015-work-chat-retention-and-account-deletion.md`,
   `docs/adr/0016-not-approved-proof-fails-quest.md`,
   `docs/adr/0017-android-only-push-notifications.md`,
   `docs/adr/0018-send-android-push-directly-to-fcm.md`, and
   `docs/adr/0019-separate-candidate-inquiry-conversation.md`.
3. Treat this document and its sub-contracts as the accepted target policy for Quest and Work Chat behavior.

## Scope

The domain covers eight user-facing surfaces:

- one Candidate Inquiry Conversation page for one Quest and one Prospective Worker;
- one Work Conversation page for one Quest;
- one read-only View Quest Condition page;
- one Edit Quest Condition page for the Hirer;
- one Sent Work page for a Worker;
- one optional Quest Image gallery for the Quest detail page;
- one Rating Review page for eligible Hirer/Worker pairs after any Terminal Quest;
- one review Popup opened from KU bot or a Push Notification.

The target uses `Hirer`, `Worker`, `Candidate`, `Prospective Worker`, `Accepted Participant`, `Assignment`, `Quest Condition`, `Proof Submission`, `Candidate Inquiry Conversation`, `Work Conversation`, `Review`, `System Message`, `Admin Review Item`, `Quest Reward`, `Quest Funding Total`, `Quest Escrow`, and `Quest Image` exactly as defined in `CONTEXT.md`.

## State and status naming

Every persisted or API state/status value uses an entity prefix in the form `<ENTITY>_<VALUE>`.

| Object                         | Field  | Allowed values                                                                                                           |
| ------------------------------ | ------ | ------------------------------------------------------------------------------------------------------------------------ |
| Quest                          | state  | `QUEST_DRAFT`, `QUEST_OPEN`, `QUEST_ASSIGNED`, `QUEST_IN_PROGRESS`, `QUEST_COMPLETED`, `QUEST_CANCELLED`, `QUEST_FAILED` |
| Assignment                     | state  | `ASSIGNMENT_ACTIVE`, `ASSIGNMENT_COMPLETED`, `ASSIGNMENT_INCOMPLETE`, `ASSIGNMENT_CANCELLED`                             |
| Conversation                   | type   | `CONVERSATION_CANDIDATE_INQUIRY`, `CONVERSATION_WORK`                                                                    |
| Candidate Inquiry Conversation | state  | `INQUIRY_OPEN`, `INQUIRY_CLOSED`                                                                                         |
| Proof Submission               | status | `PROOF_PENDING`, `PROOF_APPROVED`, `PROOF_NOT_APPROVED`                                                                  |
| Quest Edit                     | status | `EDIT_REQUEST_PENDING`, `EDIT_REQUEST_APPLIED`, `EDIT_REQUEST_FAILED`                                                    |
| Reward transfer                | status | `REWARD_TRANSFER_PENDING`, `REWARD_TRANSFER_COMPLETED`                                                                   |
| Push delivery                  | status | `PUSH_DELIVERY_PENDING`, `PUSH_DELIVERY_DELIVERED`, `PUSH_DELIVERY_FAILED`, `PUSH_DELIVERY_DISABLED`                     |

Automatic approval uses `PROOF_APPROVED`; there is no `PROOF_REJECTED` or `PROOF_AUTO_APPROVED`.

## Resolved Quest lifecycle

1. A Hirer creates `QUEST_DRAFT`.
2. Publish funds Quest Escrow and changes the Quest to `QUEST_OPEN`.
3. An accepted roster changes the Quest to `QUEST_ASSIGNED`.
4. Required Start Work actions change the Quest to `QUEST_IN_PROGRESS`.
5. Required work completes the Assignment or fails the Quest.
6. A Quest ends only as `QUEST_COMPLETED`, `QUEST_CANCELLED`, or `QUEST_FAILED`. It does not reopen.

## Constraint layers

1. **Database layer**: Enforces required fields, maximum lengths, allowed enum values, unique keys, and foreign keys.
2. **Server layer**: Enforces permissions, timing, memberships, state transitions, concurrency, and idempotency rules.
3. **UI layer**: Shows validation and state countdowns; the Server remains the sole authority.

## Sub-contracts (Disclosed Reference)

Follow the context pointer for the branch being planned or implemented:

| Branch / Area                   | Topic and triggers                                                                                                                                            | Sub-contract file                                                |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| **Lifecycle & Roster**          | Selection modes (FCFS, Candidate), Join Codes, Candidate Teams, Start Work, underfilled group consensus, completion/failure rules, cancellation matrix.       | [quest-lifecycle-contract.md](quest-lifecycle-contract.md)       |
| **Mode x Participation Matrix** | Full 2x2 matrix specification across all combinations (`SINGLE`/`GROUP` x `FCFS`/`CANDIDATE`).                                                                | [quest-mode-matrix-contract.md](quest-mode-matrix-contract.md)   |
| **Condition & Edits**           | Condition items validation, 10-minute all-Active-Worker Quest Edit protocol, `dueAt` deadlines, live countdowns.                                              | [quest-condition-contract.md](quest-condition-contract.md)       |
| **Proof & Decisions**           | Proof drafts, file attachments (1–5), locking on send, Hirer review popup, 24-hour auto-approval, `PROOF_NOT_APPROVED` failure, Admin Review Items.           | [proof-submission-contract.md](proof-submission-contract.md)     |
| **Conversations**               | Pre-assignment Candidate Inquiry (1-on-1 while `QUEST_OPEN`, closing triggers) and active Work Chat (membership, read cursors, temporary links, rate limits). | [conversation-contract.md](conversation-contract.md)             |
| **Money & Escrow**              | Inclusive Quest Funding Total, net Reward vs Platform Fee satang math, escrow reservation at publish, immediate payout, 7-day failure hold.                   | [reward-money-contract.md](reward-money-contract.md)             |
| **Rating Reviews**              | Review pairs after any Terminal Quest (`COMPLETED`, `FAILED`, `CANCELLED`), 7-day edit window, reputation updates.                                            | [rating-review-contract.md](rating-review-contract.md)           |
| **Quest Images**                | v2 Draft image upload/deletion (0–3 files, &le;5 MB, JPEG/PNG/WebP), position repacking, 15-minute temporary URLs.                                            | [quest-image-contract.md](quest-image-contract.md)               |
| **Notifications & Audit**       | KU bot System Messages, Android FCM Push notifications, critical event overrides, 1-year Audit Record retention.                                              | [notification-audit-contract.md](notification-audit-contract.md) |

## Scope boundaries & deferred capabilities

- **No voluntary departure**: An Active Worker cannot voluntarily leave or be replaced; cancellation rules define the sole departure path.
- **No Rework flow**: A non-approved Proof Submission or missed deadline fails the Quest immediately as `QUEST_FAILED`.
- **No APNs**: Push notifications target Android exclusively via FCM direct.
- **Candidate Inquiry isolation**: Candidate Inquiry Conversations never become Work Conversations and their messages are never copied to Work Chat.
