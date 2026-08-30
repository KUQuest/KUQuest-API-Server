# Superseded: Automatically cancel unfilled Quests

> **Superseded for Quest lifecycle behavior.** The accepted product rule is
> [`docs/quest/work-chat-system-target.md` §Resolved Quest lifecycle](../quest/work-chat-system-target.md#resolved-quest-lifecycle).

The current-server behavior described by this ADR automatically cancels an open
Quest that has not reached `ASSIGNED` when `startTime` passes. It is not the
target behavior for an underfilled `GROUP + FIRST_COME_FIRST_SERVED` Quest,
which uses the Hirer decision and Active Worker consent protocol in the
accepted rulebook.
