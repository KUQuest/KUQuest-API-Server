# Quest Condition and Quest Edit Contract

Part of the [Quest and Work Chat Rulebook](quest-work-chat-rulebook.md). Defines accepted policy for Quest Condition items, the 10-minute Quest Edit consensus protocol, and `dueAt` deadline rules.

## Quest Condition

- Every Quest has at least one Condition Item.
- A Condition Item is non-empty after surrounding whitespace is removed and is at most 255 characters.
- Condition Items are explicitly ordered and stable after save.
- Any Member who can view the Quest can view the ordered, read-only Condition list.
- The Hirer may change Condition Items in `QUEST_DRAFT` and, before
  participation, in `QUEST_OPEN` as specified below.
- In `QUEST_ASSIGNED`, Condition changes use the Quest Edit protocol below.

## `QUEST_OPEN` edits

The Hirer may edit an owned v2 Quest while it is `QUEST_OPEN` only before
participation starts. The Server locks the Quest row and checks participation
records in the same transaction as the edit.

- Participation starts when any Candidate application, Candidate Team, or
  Assignment record exists. This includes withdrawn applications, disbanded
  Candidate Teams, and ended Assignments. An open Candidate Inquiry
  Conversation does not start participation.
- Before participation starts, the Hirer may change `title`, `description`,
  `condition`, `mode`, `participation`, `startTime`, `dueAt`, `tagId`,
  `proofRequired`, and `locations`.
- The updated Quest must keep a Tag, a future `startTime`, and a non-null
  `dueAt` later than `startTime`. The edit cannot make a published Quest fail
  its publish-time schedule or Tag requirements.
- `questFundingTotal`, `headcount`, Quest Images, ownership, and Quest State
  cannot change through this edit. Funding fields stay fixed because the
  published Quest Escrow reservation cannot be revised by this contract.
- After participation starts, all Quest edits are refused. Existing
  Candidates, Candidate Teams, and FCFS Workers are never rewritten or removed
  by an edit.
- Each changed field appends one Quest edit history row. The edit increments
  the Quest version once and does not change its State or Quest Escrow.
- A changed `title` also updates `questTitle` on each open Candidate Inquiry
  Conversation for the Quest in the same transaction.
- An edit sends a realtime Quest-update event to the Hirer and Members with an
  open Candidate Inquiry Conversation for that Quest. The event does not add a
  Message to an inquiry. No event is sent to other Prospective Workers.
- Quest Images remain editable only in `QUEST_DRAFT`. The
  `QUEST_ASSIGNED` Quest Edit protocol below is unchanged.

## Quest Edit protocol

1. The Hirer edits a draft. The draft supports add, edit, remove, and drag-and-drop reorder.
2. The Hirer reviews the old and proposed lists. The UI labels added, removed, edited, and reordered items.
3. The Hirer submits one Quest Edit for all Active Workers.
4. Every Active Worker must accept within 10 minutes. Each Worker responds once.
5. If the last Worker accepts early, the Quest Edit becomes `EDIT_REQUEST_APPLIED` and the proposed Condition applies immediately.
6. If any Worker does not accept, including timeout, the old Condition remains and the Quest Edit becomes `EDIT_REQUEST_FAILED` without effect.
7. An `EDIT_REQUEST_PENDING` Quest Edit cannot be cancelled by the Hirer and blocks the Quest from leaving `QUEST_ASSIGNED`.
8. If an Active Worker leaves while it has `EDIT_REQUEST_PENDING`, the Quest Edit becomes `EDIT_REQUEST_FAILED` immediately and the old Condition remains.
9. After a Quest Edit ends, the Hirer may submit a new Quest Edit.

A Worker may decline without a reason. An optional decline reason is at most 255 characters. The Hirer and the Worker who wrote it can see it; other Active Workers see only that the Quest Edit has `EDIT_REQUEST_FAILED`.

## Quest edit history

- The Server appends a Quest edit history row for every applied change to a Quest. A row records the Quest, the changed field, the old value, the new value, the time, and the actor.
- A Quest Edit that becomes `EDIT_REQUEST_APPLIED` appends one `condition` row that links back to that Quest Edit. The actor is the Hirer who submitted it, not the Worker whose acceptance applied it.
- A `QUEST_DRAFT` edit appends one row per changed field. A field the Hirer resends unchanged appends no row.
- An `EDIT_REQUEST_FAILED` Quest Edit appends no row, because the Condition does not change.
- The history is append only. No actor can update or delete a row. Admin reads it as part of the Quest record.

## Due time and deadline rules

- The Hirer sets `dueAt` before publishing the Quest.
- `dueAt` cannot change after the Quest reaches `QUEST_ASSIGNED`.
- All `dueAt` values use Asia/Bangkok time.
- The Server decides whether an action is on time. A submission received at or before `dueAt` is on time.
- The UI shows a live countdown and the exact deadline.
- Reminders go to Active Workers who have not completed the required action 24 hours and 1 hour before `dueAt`; a reminder whose time has passed is skipped.
- The Server does not accept a late required action. The Assignment becomes `ASSIGNMENT_INCOMPLETE` and the Quest becomes `QUEST_FAILED`.
