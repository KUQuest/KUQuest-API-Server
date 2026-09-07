# Superseded: Automatically cancel unfilled Quests

> **Superseded for Quest lifecycle behavior.** The accepted product rule is
> [`docs/rulebook/quest/quest-work-chat-rulebook.md` §Resolved Quest lifecycle](../rulebook/quest/quest-work-chat-rulebook.md#resolved-quest-lifecycle).

The current-server behavior described by this ADR automatically cancels an open
Quest that has not reached `ASSIGNED` when `startTime` passes. It is not the
target behavior for an underfilled `GROUP + FIRST_COME_FIRST_SERVED` Quest,
which uses the Hirer decision and Active Worker consent protocol in the
accepted rulebook.
