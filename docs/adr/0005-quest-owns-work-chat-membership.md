# Quest owns Work Chat membership

**Status:** accepted

Quest is the sole authority for Accepted Participants and lifecycle state. Within the same database transaction that changes an Assignment or terminal Quest state, Quest calls a typed Work Chat membership writer; Work Chat never fetches members over HTTP and never independently creates or closes a membership window. This favors one atomic write over an independently maintained Work Chat roster, preventing assignment, `joinedAt`/`leftAt`, conversation creation, and system-message history from drifting apart.

## Atomic membership write boundary

Quest opens the transaction and owns the commit or rollback. When a Worker becomes an Accepted Participant, Quest writes the `ACTIVE` Assignment and calls the writer with `workersAccepted`; Work Chat creates the conversation when needed, writes the Hirer's `joinedAt` as the transition `occurredAt`, and writes each Worker's supplied `joinedAt`. When a Worker departs, Quest writes the inactive Assignment and calls the writer with `workerBecameInactive`; Work Chat writes that Worker's supplied `leftAt`. The transaction commits only after both the Quest change and the Chat membership write succeed; either failure rolls back both.

## Retained Chat deletion guard

Every retained Work Conversation has a database foreign key from its `quest_id` to `quest.id` with `ON DELETE RESTRICT` (or an equivalent database-enforced guard). Any attempt to physically delete a Quest while that Chat data exists must fail and leave both Quest and Chat unchanged. `HIDDEN` and `CANCELLED` are lifecycle states, not deletion paths. A later retention process may delete Chat data only under its own policy; until then, it continues to block physical Quest deletion.

## Duplicate and concurrent transitions

A retry uses the same `commandId` and returns the original result. Quest does not create a second Assignment or lifecycle change, and Chat does not create a second conversation, membership window, or system message. Chat uses `eventId` to deduplicate its system message independently.

For different commands that arrive at the same time, Quest locks the Quest row or performs an equivalent optimistic version check before it reads lifecycle state, existing Assignments, or remaining `headcount`. The command that commits first wins. Every later command re-evaluates those facts inside its own transaction: it may proceed only if the transition remains valid; otherwise it fails without calling Work Chat. This prevents overfilling a group, accepting the same Worker twice, or applying a transition after the Quest has become terminal.

## Considered options

- **Work Chat queries Quest over HTTP:** rejected because a temporary failure or stale read can authorize the wrong participant.
- **Quest publishes an asynchronous event:** rejected for this boundary because eventual delivery can leave a committed assignment without its required Chat access window.

## Consequences

- The typed contract is the only Quest → Work Chat membership input.
- Both sides deduplicate retries and serialize conflicting lifecycle changes.
- Retained Chat data blocks physical Quest deletion at the database boundary.
