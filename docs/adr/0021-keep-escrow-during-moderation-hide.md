# Keep Quest Escrow during moderation hiding

Admin moderation may move an open Quest to `QUEST_HIDDEN` without releasing its Quest Escrow. Restoring the Quest before `startTime` returns it to `QUEST_OPEN` with the original funding commitment; after `startTime`, restoration is not allowed and the Quest becomes `QUEST_CANCELLED`, which releases the reservation. This keeps a reversible moderation action separate from a terminal Quest outcome without allowing a stale Quest to reopen.
