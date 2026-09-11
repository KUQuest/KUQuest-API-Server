# A Participation projection serves Quest participants

[ADR 0027](0027-separate-quest-board-card-from-public-detail.md) split Quest
discovery into a compact `Quest Board Card` and a fuller `Public Quest Detail`,
and said why: one path that returns a different schema per role hides its
Finance exclusions instead of stating them. Quest v2 then had two read paths —
the owner projection at `/api/v2/quests/:questId` and the public one at
`/api/v2/quests/:questId/public` — and a Member who works a Quest fit neither.

The Admin Quest Hide Contract says hiding is discovery isolation only and
leaves Current Accepted Participants unaffected. The implementation honored
that by widening the `/public` read to any caller holding an `ASSIGNMENT_ACTIVE`
Assignment, which let an Active Worker read a hidden or closed Quest. The rule
was right and the placement was wrong: the accepted contract in
`docs/agents/quest-api-v2-frontend-handoff.md` states that Public Detail is not
a Worker lifecycle view, and a payload built for discovery — `hirerName`,
`activeWorkerCount` — says nothing about the reader's own Assignment.

The widening also drew the participant boundary at `ASSIGNMENT_ACTIVE`.
Settlement makes every Active Assignment terminal in one statement, so a Worker
lost the right to read a Quest at the moment it completed, failed, or was
cancelled — while the Rating Review window on that same Quest stayed open for
seven days.

So participants get their own projection: `GET
/api/v2/quests/:questId/participation`, readable by any Member holding an
Assignment on the Quest in any of its four states, in every Quest State and
while the Quest is hidden. It returns the public fields plus that Member's own
`assignment` and a `capabilities` object, and it excludes Quest Funding Total,
Platform Fee, Money Policy, Wallet, Funding Reservation, the hidden overlay, and
every Admin action. `/public` returns to its contract: a non-hidden `QUEST_OPEN`
Quest for a Member who is not the Hirer.

Three paths for one Quest is the cost. The alternative is one path whose schema
and access rule both depend on who is asking, which is what ADR 0027 declined,
and the exclusions are the part worth keeping explicit — a Worker view that
quietly inherits a Hirer field leaks money detail to the wrong reader.

Refusals stay `404 QUEST_NOT_FOUND` for a caller with no Assignment, for the
Hirer, and for a v1 Quest, following
[ADR 0004](0004-ownership-violations-read-as-missing-records.md): a `403` would
confirm the Quest exists to anyone who asks.

Status: accepted.
