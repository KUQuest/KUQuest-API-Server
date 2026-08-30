# Admin Quest Hide Contract

Part of the [Admin Rulebook](admin-rulebook.md). Defines accepted policy for Admin hiding and restoring Quests without altering Quest State or escrow.

## Scope and state independence

- Admin may hide a Quest in any non-terminal state (`QUEST_OPEN`, `QUEST_ASSIGNED`, `QUEST_IN_PROGRESS`), using the `hiddenAt` and `hiddenByAdminId` fields.
- **State independence**: `hiddenAt` is an independent timestamp flag. Hiding never writes a Quest State value. The 7 canonical Quest States in `docs/rulebook/quest/quest-work-chat-rulebook.md` remain complete; `QUEST_HIDDEN` is not a state.
- **Discovery isolation only**: Hiding removes the Quest from search and discovery only. Every other Quest rule — `dueAt`, Start Work, Proof Submission, Quest Edit, settlement, and Work Conversation access — applies unchanged while a Quest is hidden.
- The Hirer still sees and manages their own hidden Quest normally, marked hidden in their view. Current Accepted Participants are unaffected.
- Hide and restore never change Quest Escrow, Assignment state, or money balances.

## Operation and idempotency

- **Hiding**: Requires a non-empty reason and a non-blank `Idempotency-Key`.
- **Restoring**: Does not require a reason, but requires a non-blank `Idempotency-Key`.
- **No automatic expiry**: A hidden Quest stays hidden until an Admin explicitly restores it.
- Each hide and restore action creates an Audit Record.

## Notifications

- Hiding sends an Android Push Notification to the Hirer stating the Quest was hidden and the reason.
- Restoring sends an Android Push Notification to the Hirer stating the Quest was restored.
- The hidden marker in the Hirer's own Quest view remains available when Android Push permission is disabled.
