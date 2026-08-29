# Work Chat and Quest Workflow Target Spec

Status: accepted product target, 2026-08-29.

This document is the target behavior for the Work Chat, Quest Condition, Quest Edit, Sent Work, Proof Submission, review, notification, and reward flow. Use it when a task changes any of those branches.

## Read first

1. Read the root `CONTEXT.md` for the canonical vocabulary, then use this document for the settled branch behavior.
2. Read `docs/adr/0016-not-approved-proof-fails-quest.md`, `docs/adr/0017-android-only-push-notifications.md`, and `docs/adr/0018-send-android-push-directly-to-fcm.md`.
3. Treat this document as the target contract. The older Quest and Chat documents named in [Known conflicts](#known-conflicts) are not the target behavior until they are reconciled.

## Scope

The feature has five user-facing surfaces:

- one Work Conversation page for one Quest;
- one read-only View Quest Condition page;
- one Edit Quest Condition page for the Hirer;
- one Sent Work page for a Worker;
- one review Popup opened from KU bot or a Push Notification.

The target uses `Hirer`, `Worker`, `Accepted Participant`, `Assignment`, `Quest Condition`, `Proof Submission`, `System Message`, `Quest Reward`, and `Quest Escrow` exactly as defined in `CONTEXT.md`.

## State and status naming

For this target, every persisted or API state/status value uses the form
`<OBJECT>_<FIELD>_<VALUE>`. The prefix is part of the value. A UI label may use
human text, but the stored and transmitted value keeps the prefix.

| Object | Field | Allowed values |
| --- | --- | --- |
| Quest | state | `QUEST_STATE_DRAFT`, `QUEST_STATE_OPEN`, `QUEST_STATE_ASSIGNED`, `QUEST_STATE_IN_PROGRESS`, `QUEST_STATE_COMPLETED`, `QUEST_STATE_CANCELLED`, `QUEST_STATE_FAILED` |
| Assignment | state | `ASSIGNMENT_STATE_ACTIVE`, `ASSIGNMENT_STATE_COMPLETED`, `ASSIGNMENT_STATE_INCOMPLETE`, `ASSIGNMENT_STATE_CANCELLED` |
| Proof Submission | status | `PROOF_STATUS_PENDING`, `PROOF_STATUS_APPROVED`, `PROOF_STATUS_NOT_APPROVED` |
| Quest Edit | status | `QUEST_EDIT_STATUS_PENDING`, `QUEST_EDIT_STATUS_APPLIED`, `QUEST_EDIT_STATUS_FAILED` |
| Reward transfer | status | `REWARD_TRANSFER_STATUS_PENDING`, `REWARD_TRANSFER_STATUS_COMPLETED` |
| Push delivery | status | `PUSH_DELIVERY_STATUS_PENDING`, `PUSH_DELIVERY_STATUS_DELIVERED`, `PUSH_DELIVERY_STATUS_FAILED`, `PUSH_DELIVERY_STATUS_DISABLED` |

There is no bare `PENDING`, `APPROVED`, `COMPLETED`, `FAILED`, or `CANCELLED`
value in this target. Automatic approval uses `PROOF_STATUS_APPROVED`; there is
no `PROOF_STATUS_REJECTED` or `PROOF_STATUS_AUTO_APPROVED`.

## Constraint contract

Apply constraints at three layers:

1. The database enforces required fields, maximum lengths, allowed enum values,
   unique keys, and foreign keys.
2. The Server enforces permission, time, membership, state-transition,
   concurrency, and idempotency rules.
3. The UI may show the same validation, but it is not the authority.

### Structural constraints

- One Quest has exactly one Hirer and at least one Condition Item.
- One Quest has at most one Work Conversation.
- One Worker has at most one Assignment for one Quest.
- One Assignment has at most one submitted Proof Submission and at most one
  active unsent draft. Replacing a draft does not create a second submitted
  Proof Submission.
- One Quest has at most one pending Quest Edit. One Worker has at most one
  response to one Quest Edit.
- One Assignment has at most one Worker Reward payment record. A retry reuses
  that record.
- One logical Push Event has at most one Push delivery record per recipient.
  One Member may still have multiple Push Devices.
- A Message belongs to one Work Conversation. An Attachment belongs to one
  Message at most.

### Value constraints

- A Condition Item is trimmed, non-empty, and at most 255 characters.
- A Quest Condition contains at least one Condition Item. Its order is stored
  explicitly and is stable after save.
- `dueAt` is required before publish, uses Asia/Bangkok time, and is checked by
  Server time. It cannot change after the Quest reaches
  `QUEST_STATE_ASSIGNED`.
- Message text is optional only when the Message has an Attachment, and is at
  most 1,000 characters.
- A Chat Message may contain any number of Attachments. There is no total-size
  limit; each file is at most 10 MB.
- A Proof Submission has an optional description of at most 1,000 characters,
  up to five files, and requires a description or at least one file.
- Chat and Proof files are limited to image, PDF, and video. Each file is at
  most 10 MB. The system does not scan these files for malware.
- A `PROOF_STATUS_NOT_APPROVED` decision requires a reason of at most 1,000
  characters. A
  Quest Edit decline reason is optional and at most 255 characters.
- A Member may send at most 30 Chat Messages and 10 Chat Attachments per
  minute per Quest.

### Transition and concurrency constraints

- Only the allowed State/Status values in the table above may be persisted or
  returned by the target API.
- A terminal Quest uses `QUEST_STATE_COMPLETED`, `QUEST_STATE_CANCELLED`, or
  `QUEST_STATE_FAILED`. Members cannot create new Chat Messages in a terminal
  Quest.
- A Proof decision changes only from `PROOF_STATUS_PENDING` to
  `PROOF_STATUS_APPROVED` or `PROOF_STATUS_NOT_APPROVED`. The first Server
  decision wins.
- A Quest Edit response is accepted only once per Worker. The Server deadline
  and the current Active Worker set are authoritative.
- A retryable Reward transfer remains
  `REWARD_TRANSFER_STATUS_PENDING` and reuses its payment record. It cannot
  create a duplicate payment or reclaim a transferred Reward.
- A Push retry keeps one logical Event/recipient identity. Invalid destinations
  end at `PUSH_DELIVERY_STATUS_DISABLED`.

## Membership and lifecycle invariants

- There is one Work Conversation per Quest.
- Current Work Conversation members are the Hirer and Active Workers. Candidates are never members.
- A newly accepted Worker can read retained history and can receive new Messages from membership start.
- A Worker who leaves can read only Messages created no later than departure and cannot send or receive new Messages.
- A Terminal Quest is `QUEST_STATE_COMPLETED`, `QUEST_STATE_CANCELLED`, or
  `QUEST_STATE_FAILED`.
- A Terminal Quest is read-only for Members. The system may append later
  workflow System Messages.
- `QUEST_STATE_FAILED` means work was not approved or required work was not
  submitted by `dueAt`. It is distinct from `QUEST_STATE_CANCELLED`.
- There is no Rework flow.

## Quest Condition and Quest Edit

### Condition

- Every Quest has at least one Condition Item.
- A Condition Item is non-empty after surrounding whitespace is removed and is at most 255 characters.
- Condition Items are ordered.
- Any Member who can view the Quest can view the ordered, read-only Condition list.
- The Hirer may change Condition Items only while the Quest is
  `QUEST_STATE_ASSIGNED`.

### Edit protocol

1. The Hirer edits a draft. The draft supports add, edit, remove, and drag-and-drop reorder.
2. The Hirer reviews the old and proposed lists. The UI labels added, removed, edited, and reordered items.
3. The Hirer submits one Quest Edit for all Active Workers.
4. Every Active Worker must accept within 10 minutes. Each Worker responds once.
5. If the last Worker accepts early, the Quest Edit becomes
   `QUEST_EDIT_STATUS_APPLIED` and the proposed Condition applies immediately.
6. If any Worker does not accept, including timeout, the old Condition remains
   and the Quest Edit becomes `QUEST_EDIT_STATUS_FAILED` without effect.
7. A `QUEST_EDIT_STATUS_PENDING` Quest Edit cannot be cancelled by the Hirer
   and blocks the Quest from leaving `QUEST_STATE_ASSIGNED`.
8. If an Active Worker leaves while it has
   `QUEST_EDIT_STATUS_PENDING`, the Quest Edit becomes
   `QUEST_EDIT_STATUS_FAILED` immediately and the old Condition remains.
9. After it ends, the Hirer may submit a new Quest Edit.

A Worker may decline without a reason. An optional decline reason is at most
255 characters. The Hirer and the Worker who wrote it can see it; other Active
Workers see only that the Quest Edit has `QUEST_EDIT_STATUS_FAILED`.

## Due time and completion

- The Hirer sets `dueAt` before publishing the Quest.
- `dueAt` cannot change after the Quest becomes `QUEST_STATE_ASSIGNED`.
- All `dueAt` values use Asia/Bangkok time.
- The Server decides whether a submission is on time. A submission received at or before `dueAt` is on time.
- The UI shows a live countdown and the exact deadline.
- Reminders go to Active Workers who have not completed the required action 24 hours and 1 hour before `dueAt`; a reminder whose time has passed is skipped.
- The Server does not accept a late required action. The Assignment becomes
  `ASSIGNMENT_STATE_INCOMPLETE` and the Quest becomes `QUEST_STATE_FAILED`.

### Quest without proof

When `proofRequired=false`, the Worker presses “ส่งงานเสร็จแล้ว”. No Proof
Submission is created, no Hirer review is required, and that Assignment becomes
`ASSIGNMENT_STATE_COMPLETED` immediately.

- A one-Worker Quest becomes `QUEST_STATE_COMPLETED` immediately.
- A `GROUP` Quest becomes `QUEST_STATE_COMPLETED` when every Active Worker
  Assignment is `ASSIGNMENT_STATE_COMPLETED`.
- If a Worker does not press the button by `dueAt`, that Assignment becomes
  `ASSIGNMENT_STATE_INCOMPLETE` and the Quest becomes `QUEST_STATE_FAILED`.

### Quest with proof

When proof is required, an Assignment may have one Proof Submission. For a
`GROUP` Quest, the Quest remains `QUEST_STATE_IN_PROGRESS` until every required
Worker has submitted. Hirer review may start before every Worker submits.

## Proof Submission protocol

### Draft and send

- A Worker can save an unsent draft, edit it, delete it, and create a replacement draft before `dueAt`.
- A draft is visible only to its Worker and creates no System Message or notification.
- Description is optional and is at most 1,000 characters.
- A Worker can attach up to five files.
- Allowed file types are image, PDF, and video. Other types are rejected.
- Each file is at most 10 MB. The system does not scan these files for malware.
- At least one description or file is required.
- Before sending, the Worker can add, remove, or replace files. After sending, the Proof Submission is locked.
- A successful partial upload stays in the draft. A failed file is identified and can be retried or removed. Sending is blocked while a failed file remains.
- If the device is offline, sending is shown as failed and the draft remains available. The Worker must retry manually. `dueAt` remains authoritative.

### Review and decision

- Decision status is `PROOF_STATUS_PENDING`, `PROOF_STATUS_APPROVED`, or
  `PROOF_STATUS_NOT_APPROVED`.
- There is no `PROOF_STATUS_REJECTED` status. A Hirer records a failed review as
  `PROOF_STATUS_NOT_APPROVED`.
- The Hirer reviews one Proof Submission at a time. Batch decisions are not available.
- The Hirer review list is grouped by Assignment, with
  `PROOF_STATUS_PENDING` first.
- A KU bot or Push action opens the review Popup with the details, evidence, and actions.
- The Hirer must confirm an approval or non-approval in a Popup.
- Closing the Popup without a decision leaves the status
  `PROOF_STATUS_PENDING`.
- `PROOF_STATUS_NOT_APPROVED` requires a reason of at most 1,000 characters.
- The reason is visible to the Hirer and submitting Worker only. Other Accepted Participants see only a summary.
- The first confirmed decision is final. Multiple Hirer devices use the first decision accepted by the Server. Other devices refresh to that result.
- If the decision response is unclear, the UI reloads the status before allowing
  another action. A new action is allowed only while the status is still
  `PROOF_STATUS_PENDING`.
- If no decision exists 24 hours after sending, the system uses
  `PROOF_STATUS_APPROVED`. The System Message says that the system approved it
  automatically. This uses the same status and never changes an earlier
  decision.
- The Server does not accept a Proof Submission received after `dueAt`.

### Failure and partial success

- A `PROOF_STATUS_NOT_APPROVED` decision makes the Assignment
  `ASSIGNMENT_STATE_INCOMPLETE`, gives that Worker no Reward, and makes the
  Quest `QUEST_STATE_FAILED` immediately.
- No Rework or second Proof Submission exists.
- A missing required submission at `dueAt` has the same result.
- If another Worker has a Proof Submission sent on time and still
  `PROOF_STATUS_PENDING`, the Hirer may review it after the Quest becomes
  `QUEST_STATE_FAILED`.
- If that later review approves the submission, its Assignment becomes
  `ASSIGNMENT_STATE_COMPLETED` and its Worker receives the Reward. The Quest
  remains `QUEST_STATE_FAILED`.
- In a `GROUP` Quest, an approved or proof-free completed Worker keeps the
  Reward even when another Worker later causes `QUEST_STATE_FAILED`.

## Work Conversation contract

### Message behavior

- A Message may contain text, image/PDF/video Attachments, or both.
- Text is at most 1,000 characters.
- An individual Chat Message may contain any number of Attachments. There is no total-size limit; each file is at most 10 MB.
- Chat Attachments are not malware-scanned. Other file types are rejected.
- A sent Message cannot be edited, deleted, replied to, or reacted to.
- There is no Message search, typing indicator, online status, or Member-visible Read Receipt.
- Older Messages appear above newer Messages. Server acceptance time defines the order.
- The UI loads the 50 newest Messages first and loads older Messages when the Member scrolls upward.
- A new Message appears without a Popup when the Member is already on that Work Conversation page. Otherwise it uses an in-app Popup.
- If a send fails, the sender sees the failure and can retry. A retry cannot create a duplicate Message.
- Offline sending is not automatic. If the Quest becomes Terminal before retry, the Message cannot be sent.

### Attachments

- A Member can open and download an Attachment only if the Member can read its Message.
- Images open in the app. PDF and video open with a supported device app.
- Access uses a temporary link valid for 15 minutes.
- If an Attachment upload fails, successful files remain in the composer. The failed file must be retried or removed before sending.

### Read and membership behavior

- Opening the page advances the Member's private `Read Cursor` to the last displayed Message.
- A Member sees only that Member's unread count and cannot see another Member's Read Cursor.
- An empty Conversation shows a start message and keeps the composer available to Members who may send.
- A history-load error keeps already loaded Messages and shows a retry action.
- The participant list is opened from a top button or bar and shows each participant's name and role.

### Rate limits

Per Member per Quest:

- at most 30 Chat Messages per minute;
- at most 10 Chat Attachments per minute.

When limited, the UI shows the remaining wait time and preserves the Message or Attachment being prepared.

## System Message and notification contract

### System Message

- System Messages are immutable and use standard Event templates.
- They appear in the Work Conversation as messages from KU bot.
- They record membership changes, Proof Submission, approval, non-approval, deadline failure, Quest completion, Quest failure, Quest cancellation, and Quest Edit outcomes.
- They include the affected Worker's system display name and Event, but not private proof details or full Profile data.
- They include an Event-specific action link or button. The button is shown only when the Member has permission.
- Current Accepted Participants see membership and Quest Event summaries.
- On Quest completion, a Worker sees that Worker's Reward. Other participants see completion without the amount.

### Push Notification

- Production Push targets Android only. APNs/iPhone is out of scope.
- KUQuest sends directly to FCM.
- A Member can register multiple Android Push Devices and can manage only that Member's devices.
- Push is enabled by default after Android permission is granted.
- Each logical Event produces at most one alert per recipient, even after retry.
- Delivery state is recorded. Transient failures are retried. Invalid destinations are disabled.
- A new Chat Message notifies every other current Accepted Participant, never the sender.
- A directly affected Event notifies its affected recipient. A Quest-wide Event notifies all current Accepted Participants.
- A Member can mute non-critical Push per Quest. Critical Events remain deliverable.
- Critical Events include approval, non-approval, missing work at `dueAt`,
  `QUEST_STATE_FAILED`, `QUEST_STATE_COMPLETED`, `QUEST_STATE_CANCELLED`, and a
  Quest Edit requiring a response.
- When the app is active, the in-app Popup replaces the duplicate Push.
- Push contains a short update and a relevant link. It never contains private proof details or evidence.
- If Android permission is disabled, the System Message and in-app unread badge remain available.

## Reward and money contract

- Hirer funds the Quest through `Quest Escrow`.
- The system transfers a Worker Reward immediately when that Assignment becomes
  `ASSIGNMENT_STATE_COMPLETED`.
- The Hirer can see each Worker Reward and the Quest total.
- A Worker sees only that Worker's Reward.
- If a Quest is `QUEST_STATE_FAILED`, unpaid Worker-slot Rewards return to the
  Hirer. Already transferred Rewards are not reclaimed.
- A failed Quest has no Platform Fee; the fee returns to the Hirer.
- A `QUEST_STATE_CANCELLED` Quest returns unpaid Rewards and the Platform Fee.
  `ASSIGNMENT_STATE_CANCELLED` Assignments do not receive Reward.
- If a Reward transfer fails, the Assignment remains
  `ASSIGNMENT_STATE_COMPLETED`, the transfer remains
  `REWARD_TRANSFER_STATUS_PENDING`, the system retries, and Hirer/Worker are
  notified.
- Retries use the same payment record and cannot create a duplicate payment.
- A successful transfer notifies the receiving Worker and Hirer. Other participants see only Quest completion without the amount.

## Audit and retention

- An `Audit Record` stores actor or system, time, old value, new value, and reason where applicable.
- It covers Quest, Assignment, Proof Submission, Quest Reward, and Platform Fee changes.
- Detailed Audit Records are visible only to authorized roles such as Hirer and Admin.
- Other Members see the applicable System Message and current status.
- Audit Records are retained for at least one year after the Quest becomes Terminal and longer when a Report Case requires a hold.

## Implementation completion criteria

When implementation is requested, the Agent must complete all of these checks:

1. Domain state and persistence use `PROOF_STATUS_NOT_APPROVED` for the proof
   decision and `QUEST_STATE_FAILED` for Quest failure. No implementation path
   creates a Rework, `PROOF_STATUS_REJECTED`, or
   `PROOF_STATUS_AUTO_APPROVED` target status.
2. Quest Edit is available only in `QUEST_STATE_ASSIGNED`, uses the 10-minute
   all-Active-Worker protocol, and blocks work start while
   `QUEST_EDIT_STATUS_PENDING`.
3. Proof and no-proof paths produce the Assignment and Quest transitions in this document, including partial `GROUP` success and post-failure review.
4. Chat membership, read cursor, immutable Message behavior, 50-message initial load, attachment rules, offline behavior, and rate limits are tested.
5. System Message visibility, Popup actions, Android Push routing, foreground de-duplication, device retry, and invalid-device handling are tested.
6. Reward settlement is idempotent, returns unpaid funds on failure/cancellation, and never reclaims a transferred Worker Reward.
7. Every state transition and financial change has an Audit Record with the required actor, time, previous value, new value, and reason data.
8. Tests cover single Worker, `GROUP`, proof required, proof not required, timeout, non-approval, missing submission, cancellation, offline retry, concurrent Hirer decisions, and Reward transfer retry.

The work is complete only when the target behavior is represented in the domain model, persistence, API/UI behavior, notifications, money flow, and tests, and the known conflicts below are resolved.

## Known conflicts

These existing files still describe older behavior and must be updated before implementation is considered aligned:

- `docs/quest/quest-stage-milestones.md` still contains `REWORK`, a 5-minute Quest Edit window, and the older proof-free stage flow.
- `docs/chat/work-chat-contract.md` still treats Push and video as out of scope, uses older attachment-scan rules, and has older rate-limit and scaling assumptions.
- `docs/db/edr/05-quest.sql` still defines the earlier Quest lifecycle, including `REWORK`, unprefixed state values, and older cancellation and payment rules.
- `docs/chat/chat-schema-draft.sql` still defines older attachment, message, malware-scan, and unprefixed status assumptions.
- Existing Quest code still allows edits in the legacy `OPEN` state and uses
  older proof statuses such as `REJECTED` and `AUTO_APPROVED`.
- Existing Quest and Chat schema/types use unprefixed legacy state/status values; implementation must migrate them to the prefixed values in this document.
- The current proof schema still requires content, while the target allows a file-only Proof Submission.
- The repository does not yet contain the target Chat module implementation.
