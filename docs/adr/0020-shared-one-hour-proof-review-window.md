# Superseded: Use one Proof Review Window for every Quest

> **Superseded for Quest lifecycle behavior.** The accepted product rule is
> [`docs/rulebook/quest/quest-work-chat-rulebook.md` §Resolved Quest lifecycle](../rulebook/quest/quest-work-chat-rulebook.md#resolved-quest-lifecycle).

The one-hour review window described by this ADR is current-server behavior.
The accepted rulebook sets `reviewDeadlineAt` to the later of Quest `dueAt` and
24 hours after the Worker sends Proof Submission. The Server records
`PROOF_APPROVED` at that time if the Hirer has not decided.
