# Quest Lifecycle Contract

Part of the [Quest and Work Chat Rulebook](quest-work-chat-rulebook.md). Defines accepted policy for selection modes, Candidate Teams, Start Work, underfilled group consensus, completion, failure, and cancellation. For the comprehensive quadrant-by-quadrant breakdown, see the [Quest Mode and Participation Matrix Contract](quest-mode-matrix-contract.md).

## Selection modes

| Mode                             | Meaning                                                                                        |
| -------------------------------- | ---------------------------------------------------------------------------------------------- |
| `FIRST_COME_FIRST_SERVED` (FCFS) | An eligible Worker joins an open Quest directly.                                               |
| `CANDIDATE`                      | A Candidate applies, or a Candidate Team forms; the Hirer selects the accepted Worker or Team. |

`NO_CANDIDATE` is a legacy implementation name. It is not a target mode.

## Candidate lifecycle

- A `SINGLE + CANDIDATE` Candidate may withdraw that Candidate's application while the Quest is `QUEST_OPEN`.
- A Candidate Team forms only for `GROUP + CANDIDATE`.
- Before the Server creates a Candidate Team, its Team Leader enters the Team `headcount`. It must be from 2 through the published Quest `headcount`, and the Team Leader counts as one Member.
- The Server generates one Join Code for the forming Team. The Team Leader sends the code to prospective Team Members. Code format and generation mechanics are a backend security decision.
- An eligible Prospective Worker joins only by accepting the current Join Code, until the Team reaches its entered Team `headcount`. A Candidate may belong to one Team for one Quest.
- A Join Code is valid for 24 hours. The Team Leader may regenerate it; the prior code becomes invalid.
- A forming Member may leave. The Team Leader may remove another Member. If the Team Leader leaves, leadership transfers to the earliest joined remaining Member. If the last Member leaves, the Team disbands.
- At the entered Team `headcount`, the Team Leader explicitly submits the Team to the Hirer. The submission must contain text and may contain files. Each file follows the type and size rules for a Work Conversation Attachment. A submitted Team is immutable and its Join Code is invalid.
- A submitted Team cannot withdraw.
- Hirer selection creates the accepted Assignment roster and rejects every other Candidate application and submitted Team in the same transaction.
- A Candidate Quest still `QUEST_OPEN` at `startTime` cancels.

## Start Work

The required starter can press Start Work only from `startTime` through `dueAt`. A required starter who has not pressed Start Work by `dueAt` fails the Quest. The affected Assignment becomes `ASSIGNMENT_INCOMPLETE`.

| Participation and mode             | Required starter    | Required work submitter                          |
| ---------------------------------- | ------------------- | ------------------------------------------------ |
| `SINGLE + FIRST_COME_FIRST_SERVED` | Worker              | Worker                                           |
| `SINGLE + CANDIDATE`               | Worker              | Worker                                           |
| `GROUP + FIRST_COME_FIRST_SERVED`  | Every Active Worker | Every Active Worker submits that Worker's work.  |
| `GROUP + CANDIDATE`                | Team Leader         | Team Leader submits or confirms the Team's work. |

For a full `GROUP + FIRST_COME_FIRST_SERVED` roster, the Quest changes to `QUEST_IN_PROGRESS` only after every Active Worker has pressed Start Work. Assignment acceptance is the only general pre-start consent.

## Underfilled GROUP + FCFS Quest

At `startTime`, an underfilled `GROUP + FIRST_COME_FIRST_SERVED` Quest has fewer Active Workers than its original published `headcount`.

1. The Hirer has 10 minutes to choose proceed or cancel.
2. No Hirer choice cancels the Quest.
3. To proceed, every current Active Worker has 10 minutes to consent.
4. The consent view shows the exact new Quest Reward and `dueAt`.
5. A decline or timeout cancels the Quest. Workers recorded in the consent roster retain read access to their own response and the cancellation result after their Assignment ends. Unrelated Members cannot read the process.
6. All consent changes the Quest from `QUEST_OPEN` to `QUEST_ASSIGNED`.
7. Every current Active Worker must still press Start Work by `dueAt`.
8. The Quest changes to `QUEST_IN_PROGRESS` after every required Start Work action.
9. The original published `headcount` remains unchanged. Current Active Workers are the accepted roster, the original Worker Reward pool is split equally between them, and the earliest accepted Worker receives any remaining satang.
10. The roster freezes when the Quest starts. No later Worker can join.

## Completion and failure

- A required submitter sends Proof Submission before `dueAt` when `proofRequired=true`. A proof-free required submitter confirms completion before `dueAt` (see [Proof Submission Contract](proof-submission-contract.md)).
- The Hirer approves or does not approve each Proof Submission or proof-free Completion Confirmation.
- If the Hirer has not decided 24 hours after a Proof Submission is sent, the Server records `PROOF_APPROVED`.
- If the Hirer has not decided 24 hours after a Completion Confirmation is created, the Server records `COMPLETION_CONFIRMATION_APPROVED`.
- Approved Team work makes every Active Worker Assignment in a `GROUP + CANDIDATE` Quest `ASSIGNMENT_COMPLETED`.
- Approved or proof-free `GROUP + CANDIDATE` Team work opens a 24-hour Team Reward Allocation window after the Quest becomes `QUEST_COMPLETED`. The Team Leader assigns each teammate a percentage; the Leader receives the remainder. Teammate percentages cannot exceed 100% in total. If no allocation is submitted before the deadline, the Server applies an equal split. Every member's Assignment is completed when the work succeeds; payment waits for the allocation and then goes directly from Quest Escrow to each member's Earnings Balance.
- Non-approved Team work makes every Active Worker Assignment in a `GROUP + CANDIDATE` Quest `ASSIGNMENT_INCOMPLETE` and gives them no Reward.
- A missing required Team Proof Submission or Team confirmation makes every Active Worker Assignment in a `GROUP + CANDIDATE` Quest `ASSIGNMENT_INCOMPLETE`.
- In `GROUP + FIRST_COME_FIRST_SERVED`, Hirer non-approval makes only the affected Assignment `ASSIGNMENT_INCOMPLETE`. Other Active Workers can finish their work. The Quest becomes `QUEST_COMPLETED` when all Assignments have a final result and at least one Assignment is completed; otherwise it becomes `QUEST_FAILED` (see [Quest Mode Matrix Contract](quest-mode-matrix-contract.md)).
- Hirer non-approval, a missing required submission, a missing proof-free confirmation, or a missing Start Work action at `dueAt` makes the Quest `QUEST_FAILED`.
- Failure gives the affected Assignment `ASSIGNMENT_INCOMPLETE`. No Rework or second Proof Submission exists.
- In a `GROUP` Quest, an Assignment that completed before another Assignment fails keeps its Quest Reward. When the Quest becomes `QUEST_FAILED`, it remains `QUEST_FAILED`.
- In `GROUP + FIRST_COME_FIRST_SERVED`, a Quest with at least one `ASSIGNMENT_COMPLETED` Assignment and one `ASSIGNMENT_INCOMPLETE` Assignment ends as `QUEST_COMPLETED` after every Worker has a final Proof Submission or Completion Confirmation decision.

## Cancellation settlement

| Quest State at cancellation | Settlement result                                                                                                                                                                                                                                                                                                                   |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `QUEST_OPEN`                | Refund the Hirer 100% of Quest Escrow.                                                                                                                                                                                                                                                                                              |
| `QUEST_ASSIGNED`            | Pay 20% of the Worker Reward pool to Active Workers. For `GROUP + CANDIDATE`, pay the full 20% only to the Team Leader. Return 80% and the Platform Fee to the Hirer.                                                                                                                                                               |
| `QUEST_IN_PROGRESS`         | Settle full Worker Rewards and the Platform Fee. For `GROUP + CANDIDATE`, pay the full Worker Reward pool to the Team Leader. The Hirer receives no refund. A Worker or Team with a pending proof-free Completion Confirmation receives no Reward for that confirmation; return its unsettled Reward and Platform Fee to the Hirer. |

When the Hirer cancels or an Admin terminates a `QUEST_IN_PROGRESS` Quest, the Server changes each pending proof-free Completion Confirmation to `COMPLETION_CONFIRMATION_CANCELLED`. Cancellation is not a Hirer non-approval and does not create an Admin Review Item. Do not pay the Reward for the affected Worker or Team. Return that Worker's or Team's unsettled Reward and Platform Fee to the Hirer. Keep the normal cancellation settlement for other Active Workers and preserve any Reward already paid after an approved Completion Confirmation. Affected Members must refresh the Completion Confirmation list after cancellation or termination.

An Active Worker cannot voluntarily leave or be replaced. The cancellation rules create the allowed departure transition.

Cancellation — Hirer, automatic, or Admin termination alike — is available only from `QUEST_DRAFT`, which moves no money, and from the three states above. Every other non-terminal state refuses it, because no settlement is defined for a Quest whose work is already submitted, approved, in Rework, paused for Quest Edit consent, or disputed. `QUEST_DISPUTED` in particular holds its funding for the Dispute Case window (see [ADR 0024](../../adr/0024-hold-quest-failure-settlement-for-dispute-window.md)), and a `QUEST_CANCELLED` Quest has no Dispute Case path. Widening cancellation to any of these states requires a new row in the matrix first.

## Dispute Case window

A Dispute Case may exist after `QUEST_FAILED`. It does not reopen or change the Quest State. An Admin Review Item remains the automatic review and audit record for `PROOF_NOT_APPROVED`; it is not a Dispute Case.

Its actors, deadline, shared per-Quest cap, decision rules, and money movement are defined in `docs/rulebook/admin/admin-rulebook.md` §2 and [Reward & Money Contract](reward-money-contract.md).
