# Keep Quest Escrow during moderation hiding

Hiding a Quest for moderation never moves money. Quest Escrow, Assignment
state, and every settlement rule stay exactly as they were. Hiding removes the
Quest from search and discovery only, so a Hirer who funded a Quest is not
punished by an Admin action that is still under review, and a Worker already
holding an Assignment keeps the reward the Quest reserved.

This ADR originally recorded a current-server model that expressed hiding as a
`QUEST_HIDDEN` Quest State. That mechanism is superseded.
`docs/rulebook/admin/admin-rulebook.md` §3 makes `hiddenAt` an independent flag, so hiding
writes no Quest State and the seven states in
[`docs/rulebook/quest/quest-work-chat-rulebook.md` §State and status naming](../rulebook/quest/quest-work-chat-rulebook.md#state-and-status-naming)
stay complete. The escrow decision above is unchanged by that correction and
still holds.

Status: accepted.
