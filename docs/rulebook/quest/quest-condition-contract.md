# Quest Condition and Quest Edit Contract

Part of the [Quest and Work Chat Rulebook](quest-work-chat-rulebook.md). Defines accepted policy for Quest Condition items, the 10-minute Quest Edit consensus protocol, and `dueAt` deadline rules.

## Quest Condition

- Every Quest has at least one Condition Item.
- A Condition Item is non-empty after surrounding whitespace is removed and is at most 255 characters.
- Condition Items are explicitly ordered and stable after save.
- Any Member who can view the Quest can view the ordered, read-only Condition list.
- The Hirer may change Condition Items only while the Quest is `QUEST_ASSIGNED`.

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

## Due time and deadline rules

- The Hirer sets `dueAt` before publishing the Quest.
- `dueAt` cannot change after the Quest reaches `QUEST_ASSIGNED`.
- All `dueAt` values use Asia/Bangkok time.
- The Server decides whether an action is on time. A submission received at or before `dueAt` is on time.
- The UI shows a live countdown and the exact deadline.
- Reminders go to Active Workers who have not completed the required action 24 hours and 1 hour before `dueAt`; a reminder whose time has passed is skipped.
- The Server does not accept a late required action. The Assignment becomes `ASSIGNMENT_INCOMPLETE` and the Quest becomes `QUEST_FAILED`.
