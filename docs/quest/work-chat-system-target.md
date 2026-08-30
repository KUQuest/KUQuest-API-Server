# Work Chat and Quest Workflow Target Spec

Status: accepted product target, 2026-08-29.

This document is the target behavior for Candidate Inquiry Conversation,
Work Chat, Quest Condition, Quest Edit, Sent Work, Proof Submission, review,
notification, and reward flow. Use it when a task changes any of those
branches.

## Read first

1. Read the root `CONTEXT.md` for the canonical vocabulary, then use this document for the settled branch behavior.
2. Read `docs/adr/0015-work-chat-retention-and-account-deletion.md`,
   `docs/adr/0016-not-approved-proof-fails-quest.md`,
   `docs/adr/0017-android-only-push-notifications.md`,
   `docs/adr/0018-send-android-push-directly-to-fcm.md`, and
   `docs/adr/0019-separate-candidate-inquiry-conversation.md`.
3. Treat this document as the target contract. The older Quest and Chat documents named in [Known conflicts](#known-conflicts) are not the target behavior until they are reconciled.

## Scope

The feature has seven user-facing surfaces:

- one Candidate Inquiry Conversation page for one Quest and one Prospective Worker;
- one Work Conversation page for one Quest;
- one read-only View Quest Condition page;
- one Edit Quest Condition page for the Hirer;
- one Sent Work page for a Worker;
- one Rating Review page for eligible Hirer/Worker pairs after any Terminal Quest;
- one review Popup opened from KU bot or a Push Notification.

The target uses `Hirer`, `Worker`, `Candidate`, `Prospective Worker`,
`Accepted Participant`, `Assignment`, `Quest Condition`, `Proof Submission`,
`Candidate Inquiry Conversation`, `Work Conversation`, `Review`,
`System Message`, `Admin Review Item`, `Quest Reward`, and `Quest Escrow`
exactly as defined in `CONTEXT.md`.

## State and status naming

For this target, every persisted or API state/status value uses an entity
prefix in the form `<ENTITY>_<VALUE>`. The prefix is part of the value. This
follows the entity-prefix convention in the Quest EDR. A UI label may use
human text, but the stored and transmitted value keeps the prefix.

| Object | Field | Allowed values |
| --- | --- | --- |
| Quest | state | `QUEST_DRAFT`, `QUEST_OPEN`, `QUEST_ASSIGNED`, `QUEST_IN_PROGRESS`, `QUEST_COMPLETED`, `QUEST_CANCELLED`, `QUEST_FAILED` |
| Assignment | state | `ASSIGNMENT_ACTIVE`, `ASSIGNMENT_COMPLETED`, `ASSIGNMENT_INCOMPLETE`, `ASSIGNMENT_CANCELLED` |
| Conversation | type | `CONVERSATION_CANDIDATE_INQUIRY`, `CONVERSATION_WORK` |
| Candidate Inquiry Conversation | state | `INQUIRY_OPEN`, `INQUIRY_CLOSED` |
| Proof Submission | status | `PROOF_PENDING`, `PROOF_APPROVED`, `PROOF_NOT_APPROVED` |
| Quest Edit | status | `EDIT_REQUEST_PENDING`, `EDIT_REQUEST_APPLIED`, `EDIT_REQUEST_FAILED` |
| Reward transfer | status | `REWARD_TRANSFER_PENDING`, `REWARD_TRANSFER_COMPLETED` |
| Push delivery | status | `PUSH_DELIVERY_PENDING`, `PUSH_DELIVERY_DELIVERED`, `PUSH_DELIVERY_FAILED`, `PUSH_DELIVERY_DISABLED` |

There is no bare `PENDING`, `APPROVED`, `COMPLETED`, `FAILED`, or `CANCELLED`
value in this target. Automatic approval uses `PROOF_APPROVED`; there is no
`PROOF_REJECTED` or `PROOF_AUTO_APPROVED`.

## Resolved Quest lifecycle

This section is the product source of truth for Quest selection, start,
completion, failure, and cancellation. The Server enforces every time and State
rule. Payment-provider execution is outside this document.

### Lifecycle

1. A Hirer creates `QUEST_DRAFT`.
2. Publish funds Quest Escrow and changes the Quest to `QUEST_OPEN`.
3. An accepted roster changes the Quest to `QUEST_ASSIGNED`.
4. Required Start Work actions change the Quest to `QUEST_IN_PROGRESS`.
5. Required work completes the Assignment or fails the Quest.
6. A Quest ends only as `QUEST_COMPLETED`, `QUEST_CANCELLED`, or
   `QUEST_FAILED`. It does not reopen.

### Selection modes

| Mode | Meaning |
| --- | --- |
| `FIRST_COME_FIRST_SERVED` (FCFS) | An eligible Worker joins an open Quest directly. |
| `CANDIDATE` | A Candidate applies, or a Candidate Team forms; the Hirer selects the accepted Worker or Team. |

`NO_CANDIDATE` is a legacy implementation name. It is not a target mode.

### Candidate lifecycle

- A `SINGLE + CANDIDATE` Candidate may withdraw that Candidate's application
  while the Quest is `QUEST_OPEN`.
- A Candidate Team forms only for `GROUP + CANDIDATE`.
- The Server generates one Join Code for a forming Team. Code format and
  generation mechanics are a backend security decision.
- An eligible Prospective Worker may join with the current Join Code until the
  Team reaches `headcount`. A Candidate may belong to one Team for one Quest.
- A Join Code is valid for 24 hours. The Team Leader may regenerate it; the
  prior code becomes invalid.
- A forming Member may leave. The Team Leader may remove another Member. If the
  Team Leader leaves, leadership transfers to the earliest joined remaining
  Member. If the last Member leaves, the Team disbands.
- At exact `headcount`, the Team Leader explicitly submits the Team. A
  submitted Team is immutable and its Join Code is invalid.
- A submitted Team cannot withdraw.
- Hirer selection creates the accepted Assignment roster and rejects every
  other Candidate application and submitted Team in the same transaction.
- A Candidate Quest still `QUEST_OPEN` at `startTime` cancels.

### Start Work

The required starter can press Start Work only from `startTime` through
`dueAt`. A required starter who has not pressed Start Work by `dueAt` fails the
Quest. The affected Assignment becomes `ASSIGNMENT_INCOMPLETE`.

| Participation and mode | Required starter | Required work submitter |
| --- | --- | --- |
| `SINGLE + FIRST_COME_FIRST_SERVED` | Worker | Worker |
| `SINGLE + CANDIDATE` | Worker | Worker |
| `GROUP + FIRST_COME_FIRST_SERVED` | Every Active Worker | Every Active Worker submits that Worker's work. |
| `GROUP + CANDIDATE` | Team Leader | Team Leader submits or confirms the Team's work. |

For a full `GROUP + FIRST_COME_FIRST_SERVED` roster, the Quest changes to
`QUEST_IN_PROGRESS` only after every Active Worker has pressed Start Work.
Assignment acceptance is the only general pre-start consent.

### Underfilled GROUP + FCFS Quest

At `startTime`, an underfilled `GROUP + FIRST_COME_FIRST_SERVED` Quest has
fewer Active Workers than its original published `headcount`.

1. The Hirer has 10 minutes to choose proceed or cancel.
2. No Hirer choice cancels the Quest.
3. To proceed, every current Active Worker has 10 minutes to consent.
4. The consent view shows the exact new Quest Reward and `dueAt`.
5. A decline or timeout cancels the Quest.
6. All consent changes the Quest from `QUEST_OPEN` to `QUEST_ASSIGNED`.
7. Every current Active Worker must still press Start Work by `dueAt`.
8. The Quest changes to `QUEST_IN_PROGRESS` after every required Start Work
   action.
9. The original published `headcount` remains unchanged. Current Active Workers
   are the accepted roster, the original Worker Reward pool is split equally
   between them, and the earliest accepted Worker receives any remaining satang.
10. The roster freezes when the Quest starts. No later Worker can join.

### Completion and failure

- A required submitter sends Proof Submission before `dueAt` when
  `proofRequired=true`. A proof-free required submitter confirms completion
  before `dueAt`.
- The Hirer approves or does not approve each submitted Proof Submission.
- If the Hirer has not decided 24 hours after a Proof Submission is sent, the
  Server records `PROOF_APPROVED`.
- Approved or proof-free Team work makes every Active Worker Assignment in a
  `GROUP + CANDIDATE` Quest `ASSIGNMENT_COMPLETED`.
- Non-approved Team work makes every Active Worker Assignment in a
  `GROUP + CANDIDATE` Quest `ASSIGNMENT_INCOMPLETE`.
- A missing required Team Proof Submission or Team confirmation makes every
  Active Worker Assignment in a `GROUP + CANDIDATE` Quest
  `ASSIGNMENT_INCOMPLETE`.
- Hirer non-approval, a missing required submission, a missing proof-free
  confirmation, or a missing Start Work action at `dueAt` makes the Quest
  `QUEST_FAILED`.
- Failure gives the affected Assignment `ASSIGNMENT_INCOMPLETE`. No Rework or
  second Proof Submission exists.
- In a GROUP Quest, an Assignment that completed before another Assignment
  fails keeps its Quest Reward. The Quest remains `QUEST_FAILED`.

### Cancellation

| Quest State | Settlement result |
| --- | --- |
| `QUEST_OPEN` | Refund the Hirer. |
| `QUEST_ASSIGNED` | Pay 20% of the Worker Reward pool to Active Workers. Return 80% and the Platform Fee to the Hirer. |
| `QUEST_IN_PROGRESS` | Settle full Worker Rewards and the Platform Fee. The Hirer receives no refund. |

An Active Worker cannot voluntarily leave or be replaced. The cancellation
rules create the allowed departure transition.

### Dispute Case

A Dispute Case may exist after `QUEST_FAILED`. It does not reopen or change the
Quest State. An Admin Review Item remains the automatic review and audit record
for `PROOF_NOT_APPROVED`; it is not a Dispute Case.

Its actors, deadline, shared per-Quest cap, decision rules, and money movement
are defined in `docs/admin/admin-role.md` §2. That document also holds the
returned failure settlement for 7 days before the Hirer can spend it — see
[Reward and money contract](#reward-and-money-contract) and
`docs/adr/0024-hold-quest-failure-settlement-for-dispute-window.md`.

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
- One Quest can have many Candidate Inquiry Conversations, with at most one
  per Prospective Worker.
- A Candidate Inquiry Conversation has exactly one Hirer and one Prospective
  Worker. It is never a Work Conversation and never has a third participant.
- One Worker has at most one Assignment for one Quest.
- One Assignment has at most one submitted Proof Submission and at most one
  active unsent draft. Replacing a draft does not create a second submitted
  Proof Submission.
- One Quest has at most one pending Quest Edit. One Worker has at most one
  response to one Quest Edit.
- One confirmed `PROOF_NOT_APPROVED` decision creates at most one Admin Review
  Item. A retry reuses that Item.
- One Hirer and one Worker can create at most one Review in each direction for
  one Quest.
- One Assignment has at most one Worker Reward payment record. A retry reuses
  that record.
- One logical Push Event has at most one Push delivery record per recipient.
  One Member may still have multiple Push Devices.
- A Message belongs to one Conversation. An Attachment belongs to one Message
  at most.

### Value constraints

- A Condition Item is trimmed, non-empty, and at most 255 characters.
- A Quest Condition contains at least one Condition Item. Its order is stored
  explicitly and is stable after save.
- `dueAt` is required before publish, uses Asia/Bangkok time, and is checked by
  Server time. It cannot change after the Quest reaches
  `QUEST_ASSIGNED`.
- Message text is optional only when the Message has an Attachment, and is at
  most 1,000 characters.
- A Chat Message may contain any number of Attachments. There is no total-size
  limit; each file is at most 10 MB.
- A Proof Submission has an optional description of at most 1,000 characters,
  up to five files, and requires a description or at least one file.
- Chat and Proof files are limited to image, PDF, and video. Each file is at
  most 10 MB. The system does not scan these files for malware.
- A `PROOF_NOT_APPROVED` decision requires a reason of at most 1,000
  characters. A
  Quest Edit decline reason is optional and at most 255 characters.
- A Member may send at most 30 Chat Messages and 10 Chat Attachments per
  minute per Quest.

### Transition and concurrency constraints

- Only the allowed State/Status values in the table above may be persisted or
  returned by the target API.
- `INQUIRY_OPEN` changes only to `INQUIRY_CLOSED`. A closed Candidate Inquiry
  Conversation cannot be reopened.
- A terminal Quest uses `QUEST_COMPLETED`, `QUEST_CANCELLED`, or
  `QUEST_FAILED`. Members cannot create new Chat Messages in a terminal
  Quest.
- A Proof decision changes only from `PROOF_PENDING` to
  `PROOF_APPROVED` or `PROOF_NOT_APPROVED`. The first Server
  decision wins.
- A confirmed `PROOF_NOT_APPROVED` decision creates the Admin Review Item and
  starts its Admin notification. Notification failure does not undo
  `QUEST_FAILED`; retry keeps the same Item and Event identity.
- A Quest Edit response is accepted only once per Worker. The Server deadline
  and the current Active Worker set are authoritative.
- A retryable Reward transfer remains
  `REWARD_TRANSFER_PENDING` and reuses its payment record. It cannot
  create a duplicate payment or reclaim a transferred Reward.
- A Push retry keeps one logical Event/recipient identity. Invalid destinations
  end at `PUSH_DELIVERY_DISABLED`.

## Membership and lifecycle invariants

- There is one Work Conversation per Quest.
- Current Work Conversation members are the Hirer and Active Workers. Candidates are never members.
- A newly accepted Worker can read retained history and can receive new Messages from membership start.
- A Worker who leaves can read only Messages created no later than departure and cannot send or receive new Messages.
- A Terminal Quest is `QUEST_COMPLETED`, `QUEST_CANCELLED`, or
  `QUEST_FAILED`.
- A Terminal Quest's Work Conversation is read-only for Members. Eligible
  Hirers and Workers may still create or edit Reviews under the Rating Review
  contract. The system may append later workflow System Messages.
- `QUEST_FAILED` means work was not approved or required work was not
  submitted by `dueAt`. It is distinct from `QUEST_CANCELLED`.
- There is no Rework flow.
- Candidate Inquiry Conversation access is separate from Work Conversation
  membership. A Candidate or Prospective Worker is never added to the Work
  Conversation before an Assignment exists.

## Quest Condition and Quest Edit

### Condition

- Every Quest has at least one Condition Item.
- A Condition Item is non-empty after surrounding whitespace is removed and is at most 255 characters.
- Condition Items are ordered.
- Any Member who can view the Quest can view the ordered, read-only Condition list.
- The Hirer may change Condition Items only while the Quest is
  `QUEST_ASSIGNED`.

### Edit protocol

1. The Hirer edits a draft. The draft supports add, edit, remove, and drag-and-drop reorder.
2. The Hirer reviews the old and proposed lists. The UI labels added, removed, edited, and reordered items.
3. The Hirer submits one Quest Edit for all Active Workers.
4. Every Active Worker must accept within 10 minutes. Each Worker responds once.
5. If the last Worker accepts early, the Quest Edit becomes
   `EDIT_REQUEST_APPLIED` and the proposed Condition applies immediately.
6. If any Worker does not accept, including timeout, the old Condition remains
   and the Quest Edit becomes `EDIT_REQUEST_FAILED` without effect.
7. An `EDIT_REQUEST_PENDING` Quest Edit cannot be cancelled by the Hirer
   and blocks the Quest from leaving `QUEST_ASSIGNED`.
8. If an Active Worker leaves while it has
   `EDIT_REQUEST_PENDING`, the Quest Edit becomes
   `EDIT_REQUEST_FAILED` immediately and the old Condition remains.
9. After it ends, the Hirer may submit a new Quest Edit.

A Worker may decline without a reason. An optional decline reason is at most
255 characters. The Hirer and the Worker who wrote it can see it; other Active
Workers see only that the Quest Edit has `EDIT_REQUEST_FAILED`.

## Due time and completion

- The Hirer sets `dueAt` before publishing the Quest.
- `dueAt` cannot change after the Quest becomes `QUEST_ASSIGNED`.
- All `dueAt` values use Asia/Bangkok time.
- The Server decides whether a submission is on time. A submission received at or before `dueAt` is on time.
- The UI shows a live countdown and the exact deadline.
- Reminders go to Active Workers who have not completed the required action 24 hours and 1 hour before `dueAt`; a reminder whose time has passed is skipped.
- The Server does not accept a late required action. The Assignment becomes
  `ASSIGNMENT_INCOMPLETE` and the Quest becomes `QUEST_FAILED`.

### Quest without proof

When `proofRequired=false`, the required work submitter in
[Resolved Quest lifecycle](#resolved-quest-lifecycle) confirms completion. No
Proof Submission is created and no Hirer review is required.

- A proof-free `SINGLE` Quest completes when its Worker confirms.
- A proof-free `GROUP + FIRST_COME_FIRST_SERVED` Quest completes when every
  Active Worker confirms.
- A proof-free `GROUP + CANDIDATE` Quest completes every Active Worker
  Assignment when the Team Leader confirms the Team's work.
- Missing confirmation uses the failure rule in
  [Resolved Quest lifecycle](#resolved-quest-lifecycle).

### Quest with proof

When proof is required, the required work submitter and completion result are
defined in [Resolved Quest lifecycle](#resolved-quest-lifecycle). For
`GROUP + CANDIDATE`, approved Team work completes every Active Worker
Assignment; non-approved or missing Team work makes every such Assignment
incomplete.

## Proof Submission protocol

### Draft and send

- The required work submitter can save an unsent draft, edit it, delete it, and create a replacement draft before `dueAt`. A draft is visible only to that submitter and creates no System Message or notification.
- Description is optional and is at most 1,000 characters.
- The required work submitter can attach up to five files.
- Allowed file types are image, PDF, and video. Other types are rejected.
- Each file is at most 10 MB. The system does not scan these files for malware.
- At least one description or file is required.
- Before sending, the Worker can add, remove, or replace files. After sending, the Proof Submission is locked.
- A successful partial upload stays in the draft. A failed file is identified and can be retried or removed. Sending is blocked while a failed file remains.
- If the device is offline, sending is shown as failed and the draft remains available. The Worker must retry manually. `dueAt` remains authoritative.

### Review and decision

- Decision status is `PROOF_PENDING`, `PROOF_APPROVED`, or
  `PROOF_NOT_APPROVED`.
- There is no `PROOF_REJECTED` status. A Hirer records a failed review as
  `PROOF_NOT_APPROVED`.
- The Hirer reviews one Proof Submission at a time. Batch decisions are not available.
- The Hirer review list is grouped by Assignment, with
  `PROOF_PENDING` first.
- A KU bot or Push action opens the review Popup with the details, evidence, and actions.
- The Hirer must confirm an approval or non-approval in a Popup.
- Closing the Popup without a decision leaves the status
  `PROOF_PENDING`.
- `PROOF_NOT_APPROVED` requires a reason of at most 1,000 characters.
- The reason is visible to the Hirer, submitting Worker, and authorized Admins
  through the Admin Review Item. Other Accepted Participants see only a
  summary.
- The first confirmed decision is final. Multiple Hirer devices use the first decision accepted by the Server. Other devices refresh to that result.
- After the first confirmed `PROOF_NOT_APPROVED` decision, the system creates
  one Admin Review Item automatically. It links the Quest, Assignment, Proof
  Submission, Hirer, Worker, decision reason, and evidence references, and
  sends the Item to the Admin review queue.
- The Admin Review Item is for review and audit. It does not delay or undo
  `QUEST_FAILED`, reopen the Quest, create Rework, or allow a second Proof
  Submission. Authorized Admin access to the reason and evidence is audited.
- If the decision response is unclear, the UI reloads the status before allowing
  another action. A new action is allowed only while the status is still
  `PROOF_PENDING`.
- If no decision exists 24 hours after sending, the system uses
  `PROOF_APPROVED`. The System Message says that the system approved it
  automatically. This uses the same status and never changes an earlier
  decision.
- The Server does not accept a Proof Submission received after `dueAt`.

### Failure and partial success

- A `PROOF_NOT_APPROVED` decision makes the Assignment
  `ASSIGNMENT_INCOMPLETE`, gives that Worker no Reward, and makes the
  Quest `QUEST_FAILED` immediately.
- The same decision creates one Admin Review Item automatically. A failure to
  deliver the Admin notification does not change the Quest result; the Item
  remains available in the Admin review queue for retry.
- No Rework or second Proof Submission exists.
- A missing required submission at `dueAt` has the same result.
- If another Worker has a Proof Submission sent on time and still
  `PROOF_PENDING`, the Hirer may review it after the Quest becomes
  `QUEST_FAILED`.
- If that later review approves the submission, its Assignment becomes
  `ASSIGNMENT_COMPLETED` and its Worker receives the Reward. The Quest
  remains `QUEST_FAILED`.
- In a `GROUP` Quest, an approved or proof-free completed Worker keeps the
  Reward even when another Worker later causes `QUEST_FAILED`.

## Rating Review

- A Review becomes available after the Quest enters any Terminal State:
  `QUEST_COMPLETED`, `QUEST_FAILED`, or `QUEST_CANCELLED`.
- A Review is optional and does not delay or change the terminal Quest result.
- The Hirer may review each Worker who has an Assignment. Each Worker may
  review the Hirer. In a `GROUP` Quest, Reviews are per Hirer/Worker pair;
  Workers do not review each other.
- This includes a failed Quest after `PROOF_NOT_APPROVED` and after an Admin
  Review Item is created. A Review does not change the `QUEST_FAILED` result,
  Assignment result, Reward, or Admin Review Item.
- Each direction is allowed once per Quest. The author may edit the Review
  until seven days after the Quest becomes Terminal. Reviews cannot be deleted
  and contribute to the reviewed Member's Reputation.
- When a Deadline Review action makes a Quest Terminal, the Hirer sees the
  Rating Review page or its action link. A Worker receives a Review action from
  the terminal System Message or Push Notification.
- Any eligible Hirer or Worker can open the Rating Review page from Quest
  Detail or Quest History during the seven-day edit window. If a `GROUP` Quest
  is not Terminal yet, the Rating Review page is not shown.

## Candidate Inquiry Conversation contract

A Candidate Inquiry Conversation lets a Prospective Worker ask the Hirer
about a Quest before the Prospective Worker becomes a Worker. It is a private
one-to-one Conversation and is separate from the Work Conversation.

### Opening and access

- A Member who can view a `QUEST_OPEN` Quest may start one Candidate Inquiry
  Conversation with that Quest's Hirer. The Hirer cannot create a
  self-conversation.
- For a Candidate Quest, the Member may be a `Candidate`. For a direct-join
  Quest, the Member is a Prospective Worker until an Assignment is created.
- Starting the Conversation does not create an Assignment, change Quest State,
  or make the Member an Accepted Participant.
- The Conversation has exactly two participants: the Hirer and the
  Prospective Worker. Other Members, Candidates, and Active Workers cannot
  read or send in it.
- The Prospective Worker and Hirer may ask and answer questions about visible
  Quest information, including the Quest Condition, `dueAt`, `proofRequired`,
  and Quest Reward. Proof Submission is always a separate resource.
- The Conversation uses the shared immutable Message, Attachment, read,
  offline, and Rate Limit rules in this document. It is not a Work
  Conversation, and its Messages are not copied to one.

### Closing and disappearance

- A new Conversation starts as `INQUIRY_OPEN` while the Quest is
  `QUEST_OPEN`.
- When the Prospective Worker receives an `ASSIGNMENT_ACTIVE` Assignment, the
  Candidate Inquiry Conversation for that Member closes immediately in the
  same transaction.
- When the Quest enters `QUEST_ASSIGNED`, the Server closes every remaining
  `INQUIRY_OPEN` Conversation for that Quest. This includes inquiries from
  Members who were not selected. The close-all operation is part of the same
  transaction as the Quest State transition.
- If the Quest is cancelled before assignment, the Server also closes every
  remaining `INQUIRY_OPEN` Conversation for that Quest.
- Closing sets the state to `INQUIRY_CLOSED` and records the close time and
  close Event. The Conversation disappears from the normal Member inbox and
  Quest pages. Its Members cannot list, read, send, or download its content.
- A stale page or notification cannot restore access. A send or attachment
  retry after closing fails without creating a Message or Attachment.
- The closed inquiry history is not transferred to the Work Conversation and
  is not shown to other Accepted Participants. Physical retention follows the
  applicable Chat retention and moderation policy; “disappears” means that
  Member access and normal UI visibility end.
- Closing a Candidate Inquiry Conversation does not create a workflow
  `System Message` in the Work Conversation and does not expose its content to
  other Quest participants.

### Notification behavior

- A new Message notifies only the other participant in that Candidate Inquiry
  Conversation. It never notifies other Candidates, Active Workers, or other
  Members connected to the Quest.
- If the recipient is on the Conversation page, the app shows the Message in
  place. Otherwise, it uses the in-app Popup and Android Push rules in this
  document.
- After `INQUIRY_CLOSED`, no new Message or notification is created for that
  Conversation. A stale Push action opens no private content.

## Work Conversation contract

A Work Conversation opens when the first Worker receives an
`ASSIGNMENT_ACTIVE` Assignment. Quest creates the Conversation and adds the
Hirer and that Worker in the same transaction; later Active Workers join the
same Conversation.

### Opening and membership

- The Work Conversation has type `CONVERSATION_WORK` and there is at most one
  for one Quest.
- The Hirer and current Active Workers can read and send while the Quest is
  not terminal. Candidates and Prospective Workers have no Work Conversation
  access.
- If a `GROUP` Quest accepts Workers before the Quest reaches
  `QUEST_ASSIGNED`, the Work Conversation is already open for those Active
  Workers. Candidate Inquiry Conversations for other Prospective Workers
  remain subject to their own closing rules.
- When a Quest becomes terminal, the Work Conversation remains readable but
  becomes read-only for Members. The system may append later workflow System
  Messages.

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
- A terminal Quest Event includes a Rating Review action link for each eligible
  Hirer or Worker.
- An Admin Review Item is separate from the Work Conversation. It is not shown
  to other Accepted Participants and does not expose the private decision
  reason or evidence to them.
- On Quest completion, a Worker sees that Worker's Reward. Other participants see completion without the amount.

### Push Notification

- Production Push targets Android only. APNs/iPhone is out of scope.
- KUQuest sends directly to FCM.
- A Member can register multiple Android Push Devices and can manage only that Member's devices.
- Push is enabled by default after Android permission is granted.
- Each logical Event produces at most one alert per recipient, even after retry.
- Delivery state is recorded. Transient failures are retried. Invalid destinations are disabled.
- A new Message in a Work Conversation notifies every other current Accepted
  Participant, never the sender.
- A directly affected Event notifies its affected recipient. A Quest-wide Event notifies all current Accepted Participants.
- A Member can mute non-critical Push per Quest. Critical Events remain deliverable.
- Critical Events include approval, non-approval, missing work at `dueAt`,
  `QUEST_FAILED`, `QUEST_COMPLETED`, `QUEST_CANCELLED`, and a
  Quest Edit requiring a response.
- A terminal Quest Push includes a Rating Review link for the eligible Hirer or
  Worker. The link opens the Rating Review page and does not expose private
  proof details.
- When the app is active, the in-app Popup replaces the duplicate Push.
- Push contains a short update and a relevant link. It never contains private proof details or evidence.
- If Android permission is disabled, the System Message and in-app unread badge remain available.

## Reward and money contract

- Hirer funds the Quest through `Quest Escrow`.
- The system transfers a Worker Reward immediately when that Assignment becomes
  `ASSIGNMENT_COMPLETED`.
- The Hirer can see each Worker Reward and the Quest total.
- A Worker sees only that Worker's Reward.
- If a Quest is `QUEST_FAILED`, unpaid Worker-slot Rewards return to the
  Hirer. Already transferred Rewards are not reclaimed.
- That return is held for 7 days before the Hirer can spend it, so a Dispute
  Case still has funds to redirect. The amount and the recipient do not
  change; only the moment the Hirer can spend it moves. See
  `docs/admin/admin-role.md` §2 and
  `docs/adr/0024-hold-quest-failure-settlement-for-dispute-window.md`.
- A failed Quest has no Platform Fee; the fee returns to the Hirer.
- Cancellation settlement is defined only in
  [Resolved Quest lifecycle](#resolved-quest-lifecycle). Provider execution is
  outside this target. An `ASSIGNMENT_CANCELLED` Assignment receives no Reward.
- If a Reward transfer fails, the Assignment remains
  `ASSIGNMENT_COMPLETED`, the transfer remains
  `REWARD_TRANSFER_PENDING`, the system retries, and Hirer/Worker are
  notified.
- Retries use the same payment record and cannot create a duplicate payment.
- A successful transfer notifies the receiving Worker and Hirer. Other participants see only Quest completion without the amount.

## Audit and retention

- An `Audit Record` stores actor or system, time, old value, new value, and reason where applicable.
- It covers Quest, Assignment, Proof Submission, Admin Review Item, Quest Reward, and Platform Fee changes.
- It covers Candidate Inquiry Conversation creation, Message access, and
  `INQUIRY_CLOSED` transitions.
- Detailed Audit Records are visible only to authorized roles such as Hirer and Admin.
- Admin Review Item creation and Admin access to its reason or evidence are
  recorded as Audit Records.
- Review creation and edits are recorded with the Review author and time.
- Other Members see the applicable System Message and current status.
- Audit Records are retained for at least one year after the Quest becomes Terminal and longer when a Report Case requires a hold.

## Implementation completion criteria

When implementation is requested, the Agent must complete all of these checks:

1. Domain state and persistence use `PROOF_NOT_APPROVED` for the proof
   decision and `QUEST_FAILED` for Quest failure. No implementation path
   creates a Rework, `PROOF_REJECTED`, or `PROOF_AUTO_APPROVED` target status.
2. Every confirmed `PROOF_NOT_APPROVED` decision creates exactly one Admin
   Review Item and sends an Admin notification. Retries are idempotent, and a
   notification failure does not reopen or change the failed Quest.
3. Quest Edit is available only in `QUEST_ASSIGNED`, uses the 10-minute
   all-Active-Worker protocol, and blocks work start while
   `EDIT_REQUEST_PENDING`.
4. Proof and no-proof paths produce the Assignment and Quest transitions in this document, including partial `GROUP` success and post-failure review.
5. Chat membership, read cursor, immutable Message behavior, 50-message initial load, attachment rules, offline behavior, and rate limits are tested.
6. System Message visibility, Popup actions, Android Push routing, foreground de-duplication, device retry, and invalid-device handling are tested.
7. Reward settlement is idempotent, returns unpaid funds on failure/cancellation, and never reclaims a transferred Worker Reward.
8. Every state transition and financial change has an Audit Record with the required actor, time, previous value, new value, and reason data.
9. Tests cover single Worker, `GROUP`, proof required, proof not required, timeout, non-approval, Admin Review Item creation and retry, missing submission, cancellation, offline retry, concurrent Hirer decisions, and Reward transfer retry.
10. Review is available after `QUEST_COMPLETED`, `QUEST_FAILED`, and
    `QUEST_CANCELLED`, uses one Review per direction for each Hirer/Worker pair,
    exposes the required UI entry points, and does not change Quest or Reward
    outcomes.
11. Candidate Inquiry Conversation access is limited to the Hirer and one
    Prospective Worker while `QUEST_OPEN`, closes at the individual
    `ASSIGNMENT_ACTIVE` transition or Quest `QUEST_ASSIGNED` transition, and
    cannot be reopened or copied into the Work Conversation.
12. Start Work is accepted only from `startTime` through `dueAt`, using the
    required-starter matrix. A missing required action at `dueAt` fails the
    Quest.
13. An underfilled `GROUP + FIRST_COME_FIRST_SERVED` Quest uses the Hirer's
    10-minute decision, Active Worker consent, Reward visibility, equal-split,
    and roster-freeze rules in [Resolved Quest lifecycle](#resolved-quest-lifecycle).

The work is complete only when the target behavior is represented in the domain model, persistence, API/UI behavior, notifications, money flow, and tests, and the known conflicts below are resolved.

## Known conflicts

These sources preserve historical or current-baseline behavior. They are not
product workflow authority. Code and persistence must migrate before
implementation aligns with this target:

- `docs/deprecated/quest-stage-milestones.md` retains `REWORK`, a 5-minute Quest Edit window, and the older proof-free stage flow.
- `docs/deprecated/work-chat-contract.md` treats Push and video as out of scope and has earlier attachment, rate-limit, and scaling assumptions.
- `docs/db/edr/05-quest.sql` still defines the earlier Quest lifecycle, including `QUEST_REWORK`, older proof/review values, and older cancellation and payment rules.
- `docs/chat/chat-schema-draft.sql` still defines older attachment, message, malware-scan, and unprefixed status assumptions.
- `docs/deprecated/quest-process.md`, `docs/deprecated/bpmn-quest-api-comparison.md`, and
  `docs/deprecated/bpmn-current-state-audit.md` are historical analysis, not
  target workflow documents.
- Existing Quest code still allows edits in the legacy `OPEN` state and uses
  older proof statuses such as `REJECTED` and `AUTO_APPROVED`.
- Existing Quest and Chat schema/types still use values outside this target, including unprefixed Chat values and older Quest proof/review values; implementation must migrate them to the prefixed values in this document.
- The current proof schema still requires content, while the target allows a file-only Proof Submission.
- The repository does not yet contain the target Chat module implementation.
