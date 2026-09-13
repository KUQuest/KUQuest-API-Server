# Quest Mode and Participation Matrix Contract

Part of the [Quest and Work Chat Rulebook](quest-work-chat-rulebook.md). Defines accepted policy across all four combinations of Quest selection modes (`FIRST_COME_FIRST_SERVED`, `CANDIDATE`) and participation shapes (`SINGLE`, `GROUP`).

## 2x2 Matrix Overview

| Dimension                            | `SINGLE` (Headcount = 1)                                                                                  | `GROUP` (Headcount = 2–20)                                                                                                                                                            |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`FIRST_COME_FIRST_SERVED`** (FCFS) | **Quadrant 1**: Single direct join, single starter, single submitter, individual reward.                  | **Quadrant 3**: Multiple direct joins, underfilled consensus, all-worker start, all-worker submission, partial success allowed.                                                       |
| **`CANDIDATE`**                      | **Quadrant 2**: Single applicant selection, atomic rejection of others, single starter, single submitter. | **Quadrant 4**: Candidate Team with Team Leader-entered headcount and 24h Join Code, leader submission, team selection, leader-only start & submit, team-wide all-or-nothing outcome. |

---

## 2x2 Comparison Table

| Feature / Behavior             | `SINGLE + FCFS`                             | `SINGLE + CANDIDATE`                        | `GROUP + FCFS`                                                     | `GROUP + CANDIDATE`                                                                                                                                          |
| ------------------------------ | ------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Headcount**                  | Exactly 1                                   | Exactly 1                                   | 2 to 20                                                            | Published Quest: 2 to 20. Candidate Team: Team Leader enters 2 through the published `headcount`.                                                            |
| **Joining / Formation**        | Direct join (1st eligible wins)             | Candidate applies; Hirer selects            | Direct join slot-by-slot                                           | Team Leader enters Team `headcount`, sends the 24h Join Code, and Members accept it; Leader submits the Team with text and at least one file; Hirer selects. |
| **Application Withdrawal**     | N/A (instant join)                          | Candidate can withdraw while `QUEST_OPEN`   | N/A (instant join)                                                 | Members can leave before submission; submitted Team cannot withdraw                                                                                          |
| **Underfilled at `startTime`** | Unjoined Quest auto-cancels                 | Unselected Quest auto-cancels               | 10m Hirer choice + 10m all-Worker consent; splits pool equally     | Unselected Quest auto-cancels                                                                                                                                |
| **Required Starter**           | Worker                                      | Worker                                      | **Every Active Worker**                                            | **Team Leader only**                                                                                                                                         |
| **Required Submitter**         | Worker                                      | Worker                                      | **Every Active Worker**                                            | **Team Leader only**                                                                                                                                         |
| **Quest Edit Consent**         | Single Worker (10m)                         | Single Worker (10m)                         | **Every Active Worker** (10m)                                      | **Every Active Worker** (10m)                                                                                                                                |
| **Review & Decision**          | 1 Proof reviewed by Hirer                   | 1 Proof reviewed by Hirer                   | Hirer reviews each Worker individually                             | Hirer reviews 1 Team submission                                                                                                                              |
| **Approval Outcome**           | Completes Worker Assignment                 | Completes Worker Assignment                 | Completes individual Worker Assignment                             | Completes **every** teammate Assignment                                                                                                                      |
| **Non-Approval Outcome**       | Fails Quest (`QUEST_FAILED`)                | Fails Quest (`QUEST_FAILED`)                | Fails Quest; completed Workers keep Reward                         | Fails Quest; **every** teammate Assignment incomplete                                                                                                        |
| **Reward Allocation**          | 100% net Reward to Worker                   | 100% net Reward to Worker                   | Equal split per slot; remainder satang to earliest accepted        | The complete Worker Reward pool for all published slots goes only to the Team Leader.                                                                        |
| **Conduct Reports**            | `CONDUCT_ABANDONED`, `CONDUCT_OUT_OF_SCOPE` | `CONDUCT_ABANDONED`, `CONDUCT_OUT_OF_SCOPE` | `CONDUCT_ABANDONED`, `CONDUCT_OUT_OF_SCOPE`, **`CONDUCT_NO_SHOW`** | `CONDUCT_ABANDONED` (Leader only), `CONDUCT_OUT_OF_SCOPE`                                                                                                    |
| **Rating Review Pairs**        | Hirer &harr; Worker (1 pair)                | Hirer &harr; Worker (1 pair)                | Hirer &harr; each Worker (N pairs); no Worker-Worker review        | Hirer &harr; each teammate (N pairs); no Worker-Worker review                                                                                                |

---

## Detailed Specifications by Quadrant

### Quadrant 1: `SINGLE + FIRST_COME_FIRST_SERVED`

1. **Roster and Lifecycle**:
   - The first eligible Prospective Worker who clicks Join receives `ASSIGNMENT_ACTIVE` immediately.
   - The Quest transitions from `QUEST_OPEN` to `QUEST_ASSIGNED`.
   - If no Worker joins before `startTime`, the Quest cancels automatically, releasing 100% Quest Escrow to the Hirer.
2. **Candidate Inquiry**:
   - Available 1-on-1 between Hirer and Prospective Worker during `QUEST_OPEN`.
   - Closes immediately (`INQUIRY_CLOSED`) when that Worker joins and receives the Assignment.
3. **Start Work & Execution**:
   - The Worker must press Start Work between `startTime` and `dueAt` &rarr; Quest moves to `QUEST_IN_PROGRESS`.
   - Missing Start Work at `dueAt` fails the Quest (`QUEST_FAILED`).
4. **Quest Edit**:
   - Hirer may submit one Quest Edit during `QUEST_ASSIGNED`. The Worker has 10 minutes to accept or decline.
5. **Proof & Completion**:
   - Worker submits Proof (1–5 files) or confirms proof-free completion before `dueAt`.
   - Hirer approves (`QUEST_COMPLETED`, pays Reward) or does not approve (`QUEST_FAILED`, triggers 1 Admin Review Item and 7-day money hold).
   - 24-hour review timeout automatically approves.
6. **Conduct Reports**:
   - Hirer can file `CONDUCT_ABANDONED` against Worker if no proof/confirmation was sent.
   - Worker can file `CONDUCT_OUT_OF_SCOPE` against Hirer from `QUEST_ASSIGNED` onward.

---

### Quadrant 2: `SINGLE + CANDIDATE`

1. **Roster and Selection**:
   - Prospective Workers apply as Candidates while `QUEST_OPEN`. Candidates may withdraw applications before selection.
   - Hirer reviews applications and selects exactly one Candidate.
   - Selection creates `ASSIGNMENT_ACTIVE` for the selected Worker, changes the Quest to `QUEST_ASSIGNED`, and atomically rejects all other Candidates.
   - If no Candidate is selected by `startTime`, the Quest cancels automatically.
2. **Candidate Inquiry**:
   - Available 1-on-1 between Hirer and any Prospective Worker/Candidate during `QUEST_OPEN`.
   - Closes for the selected Member upon Assignment creation; closes for all other Candidates when Quest reaches `QUEST_ASSIGNED`.
3. **Start Work & Execution**:
   - The selected Worker must press Start Work between `startTime` and `dueAt` &rarr; `QUEST_IN_PROGRESS`.
4. **Quest Edit, Proof, and Settlement**:
   - Same execution, 10-minute edit response, proof submission (1–5 files), 24h review timeout, failure hold, and 3-tier cancellation matrix as Quadrant 1.
5. **Conduct Reports**:
   - Hirer &rarr; Worker: `CONDUCT_ABANDONED` (if work missing at `dueAt`).
   - Worker &rarr; Hirer: `CONDUCT_OUT_OF_SCOPE`.

---

### Quadrant 3: `GROUP + FIRST_COME_FIRST_SERVED`

1. **Roster and Work Chat Opening**:
   - Eligible Workers join slot-by-slot up to `headcount`.
   - The Work Conversation opens immediately upon the first Worker joining (`ASSIGNMENT_ACTIVE`).
   - If all slots fill before `startTime`, the Quest transitions to `QUEST_ASSIGNED`.
2. **Underfilled Consensus at `startTime`**:
   - If active Worker count < `headcount` at `startTime`:
     1. Hirer has 10 minutes to choose proceed or cancel.
     2. If proceeding, all current Active Workers have 10 minutes to consent to the revised reward and deadline.
     3. If all consent, Quest moves to `QUEST_ASSIGNED`. The total Worker Reward pool is split equally among active Workers (earliest accepted Worker receives remainder satang). Roster freezes.
     4. If Hirer cancels/times out or any Worker declines/times out, the Quest cancels.
3. **Start Work Duty**:
   - **Every Active Worker** must independently press Start Work between `startTime` and `dueAt`.
   - The Quest enters `QUEST_IN_PROGRESS` only after all Active Workers press Start Work.
   - Any Worker missing Start Work at `dueAt` causes `QUEST_FAILED`.
4. **Quest Edit Protocol**:
   - Hirer edits in `QUEST_ASSIGNED`. **All Active Workers** must accept within 10 minutes. Any decline or timeout restores the old Condition.
5. **Proof Submission & Partial Success**:
   - **Every Active Worker** submits individual Proof (1–5 files) or confirms completion.
   - Hirer reviews each Worker's submission individually.
   - `PROOF_NOT_APPROVED` on any Worker fails the Quest (`QUEST_FAILED`).
   - **Completed Workers keep Reward**: Any Worker who completed work before failure keeps their Reward.
   - Post-failure pending Proofs can still be reviewed by the Hirer and paid from the 7-day held Funding Reservation.
6. **Conduct Reports**:
   - Hirer &rarr; Worker: `CONDUCT_ABANDONED` (against any Worker who delivered nothing).
   - Worker &rarr; Hirer: `CONDUCT_OUT_OF_SCOPE`.
   - Worker &rarr; Worker: **`CONDUCT_NO_SHOW`** (filed by a Worker against a peer on the same Quest who delivered nothing).
7. **Rating Reviews**:
   - Strictly per Hirer/Worker pair (Hirer reviews each Worker, each Worker reviews Hirer). Workers do not review peers.

---

### Quadrant 4: `GROUP + CANDIDATE`

1. **Team Formation and Selection**:
   - Before creating a **Candidate Team**, the Team Leader enters a Team `headcount` from 2 through the published Quest `headcount`. The Team Leader counts as one Member.
   - The Server generates a 24-hour **Join Code**. The Team Leader sends it to prospective Team Members, who join only after accepting it.
   - The Team Leader manages the forming roster.
   - At the entered Team `headcount`, the Team Leader explicitly submits the immutable Team to the Hirer. The submission requires text and at least one file, and cannot withdraw.
   - Hirer selects one submitted Team &rarr; creates `ASSIGNMENT_ACTIVE` for all teammates, moves Quest to `QUEST_ASSIGNED`, and atomically rejects all other Teams and Candidates.
   - If no Team is selected by `startTime`, the Quest cancels automatically.
2. **Start Work Duty**:
   - **Team Leader ONLY** is the required starter. Pressing Start Work between `startTime` and `dueAt` transitions the Quest to `QUEST_IN_PROGRESS`.
3. **Quest Edit Protocol**:
   - **All teammates** (every Active Worker) must accept within 10 minutes.
4. **Proof Submission & Team Outcome**:
   - **Team Leader ONLY** submits the Team's Proof (1–5 files) or confirms completion on behalf of the Team before `dueAt`.
   - Hirer reviews the single Team submission:
     - `PROOF_APPROVED`: Makes **every** teammate Assignment `ASSIGNMENT_COMPLETED` and pays the complete Worker Reward pool for all published slots to the Team Leader only.
     - `PROOF_NOT_APPROVED` / Missing submission: Makes **every** teammate Assignment `ASSIGNMENT_INCOMPLETE`, fails the Quest (`QUEST_FAILED`), and creates 1 Admin Review Item.
5. **Conduct Reports**:
   - Hirer &rarr; Team Leader: `CONDUCT_ABANDONED` (against Team Leader only; teammates have no individual submission duty).
   - Worker &rarr; Hirer: `CONDUCT_OUT_OF_SCOPE`.
   - `CONDUCT_NO_SHOW` does not exist in this mode.
6. **Rating Reviews**:
   - Hirer reviews each teammate individually; each teammate reviews the Hirer. Teammates do not review each other.
