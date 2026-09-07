# Quest Process — Current-State Specification

**Status:** Draft for domain review  
**Drafted:** 2026-08-29  
**Source:** Miro BPMN audit, Activity Diagram comparison, Quest schema/EDR scout, and decisions recorded in this session  
**Scope:** Current process only. This document does not define a To-Be redesign.

> **Legacy workflow analysis.** The product source of truth is
> [`docs/rulebook/quest/quest-work-chat-rulebook.md` §Resolved Quest lifecycle](../rulebook/quest/quest-work-chat-rulebook.md#resolved-quest-lifecycle).
> This document records an earlier process comparison. It does not define new
> Quest behavior.

## 1. Purpose

This document records the current Quest process for the KUQuest Mobile app, the Hirer, Workers, Work Conversation, Wallet, and Admin dispute handling.

The Miro board contains two diagram types:

- Diagrams whose title contains **Ultimate** are treated as BPMN.
- Other process diagrams are Activity Diagrams. They are supporting evidence only. BPMN notation rules do not apply to them.

## 2. Domain terms

- **Hirer:** The Member who creates and owns a Quest.
- **Worker:** A Member accepted to perform work on a Quest.
- **Candidate:** A Member or team that applied to a Candidate Quest but is not yet accepted as a Worker.
- **Assignment:** The accepted participation of one Worker in a Quest.
- **Active Worker:** A Worker whose Assignment has not ended.
- **Quest:** One bounded agreement for work, owned by one Hirer.
- **Quest condition:** The explicit pass/fail criteria for the final work. The Hirer uses this criteria to review Final Proof.
- **Work Conversation:** The one working Conversation for a Quest. It contains the Hirer and accepted Workers, not Candidates.
- **Draft:** Work-in-progress content sent as a Message with an Attachment in the Work Conversation before final submission. A Draft is not a Proof Submission.
**Final Proof:** The final work submission sent through the Work Conversation for Hirer review.
- **Report Case:** A Trust & Safety record for a Work Conversation Message. Its relation to a Quest payment or performance Dispute remains open.
- **Review:** A rating and optional comment exchanged by the Hirer and Worker after the Quest is Completed. Each direction is allowed once within seven days.
- **FCFS:** First Come, First Served. In this specification it is the business name for `NO_CANDIDATE`.
- **Candidate mode:** A mode where the Hirer selects an application or a complete team.
- **SOLO / เดี่ยว:** The Quest needs one Worker.
- **GROUP / ทีม:** The Quest needs the exact configured headcount of Workers.
**Rework:** The BPMN branch, current process rule, and API/schema do not agree. This comparison keeps the target unresolved. A Worker may revise Draft work in the Work Conversation before sending Final Proof; no Rework rule is assumed.

## 3. Quest modes

There are two independent dimensions:

| Selection mode | Participation | Meaning |
|---|---|---|
| FCFS (`NO_CANDIDATE`) | SOLO | The first eligible Worker is accepted. |
| FCFS (`NO_CANDIDATE`) | GROUP | Eligible Workers join until the exact headcount is reached. |
| Candidate | SOLO | Workers apply. The Hirer selects one application. |
| Candidate | GROUP | A Team Leader forms a Team. The Hirer selects one complete Team. |

## 4. Lifecycle

The process uses these business milestones:

1. `DRAFT` — Hirer prepares Quest details.
2. `OPEN` — System creates a Quest Escrow/Funding Reservation, then publishes the Quest on the Quest Board.
3. `ASSIGNED` — The complete working roster is accepted.
4. Pre-start Consent — All required Members consent before work starts. The exact inclusion of the Hirer is still open.
5. `IN_PROGRESS` — After the start time, each Worker can press the Start Work button. The exact Quest-level transition when a GROUP Quest has several Workers is still open.
6. `SUBMITTED` — Final Proof or Proof-free completion confirmations await Hirer confirmation.
7. `COMPLETED` — Required confirmation/review passes and settlement is complete. This is terminal.
8. `DISPUTED` — Admin investigates the Quest Dispute path. The boundary between a Work Conversation Report Case and a Quest payment or performance Dispute is still open.
9. `CANCELLED` — Quest stops without normal completion. This is terminal.

There is no current `REWORK` milestone in the process specification.

## 5. Quest creation and publication

### 5.1 Create Draft

1. Hirer creates a Quest in `DRAFT`.
2. Hirer provides the Quest details, including:
   - title and description;
   - Quest condition;
   - selection mode: FCFS or Candidate;
   - participation: SOLO or GROUP;
   - headcount for GROUP;
   - Quest Reward;
   - start time and optional Deadline;
   - whether Proof is required.
3. System validates the Quest details.
4. Hirer may correct invalid details before publishing.

### 5.2 Publish

1. Hirer asks System to publish the Draft.
2. System creates the Quest Escrow/Funding Reservation for the required Quest funding.
3. System changes the Quest to `OPEN`.
4. System displays the Quest on the Quest Board.
5. The Platform Fee is paid by the Hirer in addition to Worker Quest Rewards when Worker payment occurs. It is not deducted from a Worker Quest Reward.

If the Reservation cannot be created, the Quest must not become `OPEN`.

## 6. Selection and Assignment

### 6.1 FCFS + SOLO

1. Worker selects an eligible Quest.
2. Worker joins the Quest.
3. System creates one active Assignment.
4. System creates or opens the Work Conversation for the Hirer and Worker.
5. Quest becomes `ASSIGNED`.

### 6.2 FCFS + GROUP

1. Each eligible Worker joins the Quest.
2. System checks the active Worker count.
3. The Quest stays `OPEN` while the count is below headcount.
4. When the exact headcount is reached:
   - System creates an Assignment for every Worker;
   - System opens the Work Conversation;
   - Quest becomes `ASSIGNED`.
5. A Worker cannot join after the Quest is full.

### 6.3 Candidate + SOLO

1. Worker applies to an eligible Candidate Quest.
2. System records the Candidate application.
3. Hirer reviews Candidate applications.
4. Hirer selects one application.
5. System creates one active Assignment and rejects the other applications.
6. System opens the Work Conversation.
7. Quest becomes `ASSIGNED`.

### 6.4 Candidate + GROUP

1. A Team Leader accepts the team-type Candidate Quest.
2. System creates the forming team and a Join Code.
3. Join Code has an expiry. The team can generate a new code.
4. Team Leader shares the code outside the app.
5. Team Members enter the code in KUQuest.
6. System validates the code and checks team capacity.
7. When the exact headcount is reached:
   - System saves the team;
   - System sends the complete team to the Hirer for selection.
8. Hirer selects the team.
9. System creates an active Assignment for every selected team Member and opens the Work Conversation.
10. Quest becomes `ASSIGNED`.

An invalid code must not add a Member to the team. A full team must reject additional Members and show a clear outcome.

## 7. Consent before work

1. After the accepted roster exists and before work starts, System asks the required Members to consent to the Quest conditions.
2. All required Members must consent.
3. If consent is complete, the Quest may proceed to the start-time step.
4. If a required Member does not consent, the Quest does not use the new agreement. The original agreement and original Deadline remain.
5. The BPMN must identify who must consent and the result of each consent branch.

This consent is separate from a post-Assignment Quest Edit consent request. The DB meaning of `QUEST_AWAITING_CONSENT` must be reconciled before implementation uses it for this process.

## 8. Starting and doing work

1. Before the start time, the Worker cannot start work.
2. After the start time, Work Conversation shows the Start Work action.
3. Worker presses Start Work.
4. System records that the Worker started.
5. Workers coordinate in the Work Conversation.
6. Workers may send Draft Messages with Attachments.
7. Hirer may request changes before Final Proof.
8. Worker may revise and send more Drafts. No Rework state or system counter is used.
9. If a Worker does not attend, Hirer starts the report or Dispute path. The boundary between a Report Case and a Quest Dispute remains open.

## 9. Deadline extension

1. Hirer and Active Workers discuss the request in the Work Conversation.
2. The new Deadline is applied only when Hirer and every Active Worker consent.
3. System records the consent and the new Deadline.
4. If any required person does not consent, the original Deadline remains.
5. A Deadline change must not silently change the Quest condition, Reward, mode, participation, headcount, or Assignment roster.

## 10. Completion

### 10.1 Final Proof Quest

1. Worker prepares Draft work in the Work Conversation.
2. Worker sends Final Proof.
3. Hirer checks Final Proof against the Quest condition.
4. Proof ownership depends on the mode:
   - FCFS + SOLO: the Worker sends their own Final Proof;
   - FCFS + GROUP: every Worker sends their own Final Proof;
   - Candidate + SOLO: the Worker sends their own Final Proof;
   - Candidate + GROUP: the Team Leader sends the Team Final Proof.
5. The Final Proof is sent through the Work Conversation.

### 10.2 Proof-free Quest

1. Each required Worker confirms work completion.
2. For a Proof-free GROUP Quest, all required Workers confirm.
3. Hirer confirms once after all required Worker confirmations exist.
4. System changes the Quest to `COMPLETED` after both sides have confirmed.

### 10.3 Final Proof does not meet the Quest condition

1. Hirer does not approve the Final Proof.
2. Hirer starts the report or Dispute path.
3. System changes the Quest to a suspended or Dispute state.
4. Admin receives the relevant case.
5. The Rework decision remains open; this path is not silently treated as Rework.
6. Draft discussion and revision should happen before Final Proof, in the Work Conversation.

## 11. Admin dispute resolution

### 11.1 Worker fault

1. Admin determines that the Worker is at fault.
2. System does not pay the Worker Quest Reward.
3. System refunds the full reserved amount to the Hirer.
4. System closes the Quest as `CANCELLED`.

### 11.2 Hirer fault

1. Admin determines that the Hirer is at fault.
2. System pays the full Quest Reward to every Worker.
3. Hirer pays the Platform Fee in addition to the Worker Rewards.
4. System closes the Quest as `COMPLETED`.

The BPMN must show the Admin decision, settlement result, terminal Quest status, and notifications.

## 12. Review

1. Review is available only after the Quest is `COMPLETED`.
2. Hirer can review each completed Worker.
3. Each completed Worker can review the Hirer.
4. Each direction is allowed once per Quest.
5. Reviews must be created within seven days after Quest completion.
6. Review must not be available before Quest completion.

## 13. Team management

1. Team Leader can create a Team only for Candidate + GROUP.
2. System creates a Join Code with an expiry.
3. Team Leader can generate a new code.
4. Team Leader can delete the forming Team.
5. Deleting the team keeps the Quest `OPEN` and allows a new team.
6. Team Leader can remove a Member while the Team is forming.
7. A removed Member can join the same team again while it remains forming.
8. A full team is sent to the Hirer for selection; it does not start work automatically.
9. Team selection creates Assignments for all selected Members.

## 14. Notifications and data

The BPMN must identify these system interactions:

- Quest publication and Quest Board visibility;
- Funding Reservation creation;
- Assignment creation;
- Work Conversation creation and membership;
- Join Code creation, expiry, regeneration, and validation;
- Draft Message and Attachment exchange;
- Final Proof submission;
- Proof-free completion confirmations;
- Report Case creation and Admin handoff;
- settlement, refund, and Platform Fee;
- Review availability and seven-day expiry.

Draft Messages and Final Proof are Work Conversation data. Final Proof is the final submission for Hirer review.

## 15. BPMN acceptance criteria

A revised Ultimate BPMN is acceptable when:

- each diagram has a named Start Event and named End Events;
- every Gateway has a question and every outgoing path has a condition;
- Sequence Flow and Message Flow are distinguishable;
- participants and responsibility boundaries are explicit;
- all four mode/participation combinations are represented;
- FCFS + GROUP and Candidate + GROUP use different assignment rules;
- pre-start Consent is separate from Quest Edit consent;
- Worker Start Work occurs only after the start time;
- Draft discussion occurs before Final Proof;
- Rework is explicitly marked unresolved. The Current State BPMN must not silently add or remove a Rework path.
- Final Proof condition failure goes to an explicit report or Dispute handoff and Admin decision.
- Proof-free completion requires Worker and Hirer confirmation;
- Admin fault outcomes reach named terminal states;
- Quest reaches Completed before Review opens;
- Team deletion, kick, invalid code, expired code, and full-team outcomes are reachable and named;
- every cross-diagram handoff is explicit.

## 16. Known conflicts to resolve

| Conflict | Evidence | Required decision |
|---|---|---|
| Rework removed from business process, but DB still contains `QUEST_REWORK` and `rework_limit` | `src/database/schema/quest.schema.ts`, `docs/db/edr/05-quest.sql`, `docs/deprecated/quest-stage-milestones.md` | Mark DB fields as legacy or plan a later DB change. |
| Candidate + GROUP is Team Leader-only for Final Proof, but the current service allows any selected Team Member to submit | `src/modules/quest/quest-proof.service.ts` | Enforce the Team Leader-only target rule or record a new domain decision. |
| Target behavior uses Join Code, but the current database schema contains Team Invitation and no Join Code field | `src/database/schema/quest.schema.ts`, `docs/db/edr/05-quest.sql` | Implement the Join Code target or record a new target decision. |
| Pre-start Consent is different from the current DB meaning of `QUEST_AWAITING_CONSENT` | `docs/db/edr/05-quest.sql` | Define a separate state or update the state contract. |

## 17. Open decisions

1. How target Work Conversation Final Proof maps to the current `/proof` endpoint.
2. Whether the Hirer is included in the pre-start Consent group.
3. The exact Quest-level transition when only some GROUP Workers have pressed Start Work.
4. Join Code length, security rule, expiry duration, and regeneration behavior.
5. The boundary, SLA, and visible statuses for a Work Conversation Report Case and a Quest payment or performance Dispute.
6. Whether the existing DB Rework fields remain as legacy data.

## 18. Miro traceability

- Registration BPMN: `3458764681933002687` / title object `3458764681933002838`
- Quest Selection BPMN: `3458764681951218123` / title object `3458764681951218579`
- Quest Doing BPMN: `3458764681959357683` / title object `3458764681959357689`
- Team Setup BPMN: `3458764681959357844` / title object `3458764681959468230`
- Approvement BPMN: `3458764681958325072` / title object `3458764681958325076`

Supporting Activity Diagrams were used for comparison only. No Miro item was edited.
