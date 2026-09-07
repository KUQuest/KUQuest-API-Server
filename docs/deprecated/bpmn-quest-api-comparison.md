# BPMN and Current Quest API: Difference Register

> **Historical difference register.** The product source of truth is
> [`docs/rulebook/quest/quest-work-chat-rulebook.md` §Resolved Quest lifecycle](../rulebook/quest/quest-work-chat-rulebook.md#resolved-quest-lifecycle).
> This document preserves the prior BPMN/API comparison. It does not define new
> Quest behavior.

## Purpose

This document compares the formal BPMN design with the current Quest API. It also checks both sources against the domain language in `CONTEXT.md`.

The comparison covers the full observable process:

1. Registration
2. Quest creation and publication
3. Worker selection and Assignment
4. Team formation
5. Pre-start Consent
6. Quest Doing
7. Draft and Final Proof
8. Settlement and Dispute
9. Review

This is a comparison and decision record. It is not an implementation plan.

## Reading rules

- **Target:** The BPMN design, with the decisions recorded below.
- **Baseline:** The current routes, services, schema, lifecycle worker, and existing process documents.
- **Domain language:** `CONTEXT.md` is the source for canonical terms.
- **Difference:** A mismatch between the Target, Baseline, and domain language. A difference is not automatically a defect.
- **Unknown:** The source does not define enough information to decide the behavior.

For this document, BPMN is the target design. The existing BPMN audit remains an evidence source. It correctly records that some BPMN branches and cross-diagram links are not fully traceable.

## Source map

### BPMN

The formal diagrams are the five `Ultimate` diagrams recorded in `docs/deprecated/bpmn-current-state-audit.md`:

| Reference | BPMN area | Widget ID |
| --- | --- | --- |
| D8 | Registration | `3458764681933002687` |
| D9 | Quest Selection | `3458764681951218123` |
| D20 | Approvement and closure | `3458764681958325072` |
| D21 | Quest Doing | `3458764681959357683` |
| D22 | Team Setup | `3458764681959357844` |

The D numbers are inferred labels. The Widget IDs are the stable references.

### Domain and process documents

- `CONTEXT.md` — canonical domain language.
- `docs/deprecated/bpmn-current-state-audit.md` — detailed BPMN inventory, evidence, and open findings.
- `docs/deprecated/quest-process.md` — current Quest process and known conflicts.
- `docs/deprecated/quest-stage-milestones.md` — Quest stage and settlement reference.
- `docs/adr/0005-quest-owns-work-chat-membership.md` — Work Conversation membership boundary.
- `docs/adr/0009-keep-money-independent-of-quest-model.md` — Wallet and Quest money boundary.

### Current API and data model

- `src/modules/quest/quest.route.ts` — Draft, publication, edit, and Quest Board routes.
- `src/modules/quest/quest-assignment.route.ts` — direct FCFS join route.
- `src/modules/quest/quest-candidate.route.ts` — applications, Teams, invitations, and Candidate selection routes.
- `src/modules/quest/quest-proof.route.ts` — Final Proof, Proof-free confirmation, and review routes.
- `src/modules/quest/quest-settlement.route.ts` — Hirer cancellation and Admin Dispute resolution routes.
- `src/modules/quest/quest.contract.ts` — Quest mode, participation, and status values.
- `src/database/schema/quest.schema.ts` — Quest, Team, invitation, proof, confirmation, and edit tables.
- `src/modules/quest/quest-lifecycle.worker.ts` — start time, Deadline, invitation expiry, Dispute, and auto-approval transitions.

### Database documentation and migrations

- No `docs/db/sql/` directory exists in this repository snapshot.
- The modular SQL documents are under `docs/db/edr/`: `00-extensions.sql`, `01-auth.sql`, `02-wallet.sql`, `03-payments.sql`, `04-profile.sql`, `05-quest.sql`, and `init.sql`.
- Quest migration evidence is in `drizzle/0032_migrate_auth_ids_to_uuid.sql` through `drizzle/0041_team_disbanded_status.sql`. The runtime Quest model is `src/database/schema/quest.schema.ts`.
- A migration file in the repository does not prove that a live PostgreSQL database has applied that migration.

## Confirmed decisions for this comparison

- Compare domain behavior, API behavior, observable boundaries, and data only when the data changes behavior.
- Treat BPMN as the target and the current Quest API as the baseline.
- Use `Hirer`, `Worker`, and `Team` as the canonical terms.
- Treat `Join Code` as the target mechanism for Candidate + GROUP Team formation.
- Require the `Team Leader` to send Candidate + GROUP Final Proof.
- Treat Final Proof as sent through the Work Conversation.
- Treat Pre-start Consent as separate from Quest Edit consent. For Candidate + `SOLO` and Candidate + `GROUP`, the Quest cannot start while any required Member has not consented. The required roster, failure result, and persistent state still need alignment.
- Keep Rework unresolved. The BPMN branch, process rule, and current schema do not agree.
- Keep the boundary between `Report Case` and Quest payment or performance Dispute unresolved.
- Use all five difference classes: missing behavior, conflicting behavior, terminology, boundary or responsibility, and unknown behavior.

## Mode map

The BPMN uses business names. The API uses enum names.

| Business mode | API mode | Participation | Target behavior |
| --- | --- | --- | --- |
| FCFS | `NO_CANDIDATE` | `SOLO` | The first eligible Worker joins. |
| FCFS | `NO_CANDIDATE` | `GROUP` | Workers join directly until exact headcount. |
| Candidate | `CANDIDATE` | `SOLO` | Workers apply. The Hirer selects one application. |
| Candidate | `CANDIDATE` | `GROUP` | A Team forms. The Hirer selects one complete Team. |

`FCFS` is the business name for `NO_CANDIDATE`. It is not a third API mode.

## Lifecycle comparison

### 1. Registration — D8

**BPMN target**

- A Member signs in with a KU Gmail address.
- The Member supplies profile information.
- Bio is limited to 2,000 characters.
- Portfolio or certificate files are optional and have a 5 MB limit.
- The system creates the Member identity or returns an error for correction.

**Current API baseline**

- Academic Registration is the canonical first-run contract.
- Profile data is served by `/api/v1/profile`.
- Certificates are served by `/api/v1/profile/certificates`.
- Member sign-in enforces the `@ku.th` Allowed Email Domain.

**Difference**

The business intent is aligned. The BPMN groups identity, Profile, portfolio, and Certificate steps into one flow. The API exposes separate resources and a resumable Academic Registration contract. This is a boundary and presentation difference, not evidence of a different Member concept.

### 2. Quest creation and publication — D9

**BPMN target**

1. The Hirer creates a `DRAFT` Quest.
2. The Hirer supplies the Quest details, Quest condition, mode, participation, headcount, Quest Reward, start time, and optional Deadline.
3. The system validates the Draft.
4. The system takes the Hirer's money before changing the Quest to `OPEN`.
5. The Quest appears on the Quest Board.

**Current API baseline**

- `POST /api/v1/quests` creates a Draft Quest owned by the authenticated Hirer.
- `GET /api/v1/quests/:questId/publish-check` reports blockers and the required Escrow amount.
- `POST /api/v1/quests/:questId/publish` creates Quest Escrow and changes `QUEST_DRAFT` to `QUEST_OPEN`.
- The Quest domain owns the reservation lifecycle. Wallet owns the reserved funds.

**Difference: `MONEY-01` — terminology and boundary**

The BPMN wording says that the Hirer's money is debited. The API creates a Quest Escrow through a Funding Reservation. The context defines this as money set aside until the Quest settles or releases it. The target document must use `Quest Escrow` or `Funding Reservation` when it means a reversible reservation. The word “debit” is ambiguous unless the BPMN names the later settlement or release.

### 3. Worker selection and Assignment — D9

**FCFS + SOLO**

- BPMN: an eligible Worker joins the open Quest directly.
- API: `POST /api/v1/quests/:questId/join` calls `joinNoCandidateQuest`.
- API: the service creates one active Assignment and changes the Quest to `QUEST_ASSIGNED`.

**FCFS + GROUP**

- BPMN: eligible Workers join directly until the group is full.
- API: the service locks the Quest row, counts active Assignments, rejects a full Quest, and changes the Quest to `QUEST_ASSIGNED` only at exact headcount.

**Candidate + SOLO**

- BPMN: Workers apply and the Hirer selects one Candidate.
- API: `POST /api/v1/quests/:questId/applications` creates an application.
- API: `POST /api/v1/quests/:questId/applications/:applicationId/select` selects one application, rejects other pending applications, creates one Assignment, and changes the Quest to `QUEST_ASSIGNED`.

**Candidate + GROUP**

- BPMN: a complete Team is sent to the Hirer for selection.
- API: a Team is created, members are added, the Team Leader submits the full Team, and the Hirer selects it with `POST /api/v1/quests/:questId/teams/:teamId/select`.
- API: selection creates an Assignment for every selected Team Member and changes the Quest to `QUEST_ASSIGNED`.

**Difference: `SEL-01` — Work Conversation runtime boundary**

Both direct join and Candidate selection require the Work Conversation membership writer in the same database transaction. The current `src/` composition does not configure that writer. The API therefore returns `503 WORK_CHAT_UNAVAILABLE` and rolls back the Assignment or selection. BPMN shows the transition as available. This is a current runtime gap against the target process.

### 4. Team formation — D22

**BPMN target**

1. A Team Leader creates a Team for Candidate + GROUP.
2. The system creates a Join Code.
3. The Team Leader shares the code.
4. Team Members enter the code in KUQuest.
5. The system validates the code and checks capacity.
6. A complete Team is sent to the Hirer for selection.

**Current API baseline**

- `POST /api/v1/quests/:questId/teams` creates a Team and its first Team Member.
- `POST /api/v1/quests/:questId/teams/:teamId/invitations` creates a targeted in-app Team Invitation.
- An invited Member accepts or declines the invitation.
- The current service sets invitation expiry to 24 hours and the lifecycle worker changes expired pending invitations to `INVITATION_EXPIRED`.
- `POST /api/v1/quests/:questId/teams/:teamId/submit` is required from the Team Leader when member count equals the Quest headcount.

**Difference: `TEAM-01` — conflicting onboarding mechanism**

Join Code is the target mechanism. The current API and schema implement targeted in-app Team Invitations. The schema has no Join Code field or Join Code validation route. The API does not currently implement the target Team onboarding behavior.

**Difference: `TEAM-02` — responsibility boundary**

The BPMN makes a full Team look like a system handoff to Hirer selection. The current API requires an explicit Team Leader `submit` action before the Team becomes `TEAM_SUBMITTED`. The target must state whether “full” only makes the Team eligible or also submits it. Join Code lifetime, security, and regeneration rules are still unknown.

### 5. Pre-start Consent — D9

**BPMN target**

After the accepted roster exists and before Quest Doing starts, the system asks the required Members to consent to the Quest conditions. For Candidate + `SOLO` and Candidate + `GROUP`, the Quest cannot start while any required Member has not consented. The BPMN does not define the full consent roster or the failure result.

**Current API baseline**

The API has `QUEST_AWAITING_CONSENT`, but `createQuestEditRequest` uses that status to pause an assigned Quest while Active Workers respond to a proposed Quest Edit. The request has a five-minute response window and returns the Quest to its previous status when it is rejected or expires.

**Difference: `CONSENT-01` — missing behavior and boundary**

Pre-start Consent is a separate domain concept. The current Quest Edit consent flow is not evidence that Pre-start Consent exists. The API has no confirmed pre-start route, roster, persistence contract, or status transition. The target rule is clear that an incomplete required consent set blocks Quest start; the required roster, consent text, denial result, and relation to `start_time` still need a separate alignment decision.

### 6. Quest Doing — D21

**BPMN target**

- A Worker can press Start Work only after the start time.
- Workers coordinate in the Work Conversation.
- Workers share Draft content before Final Proof.
- Deadline changes need consent from the Hirer and every Active Worker.
- A no-show or failed work condition starts a report or Dispute path.

**Current API baseline**

- `startDueAssignedQuests` changes due assigned Quests to the in-progress state using `start_time`.
- Draft content is represented by Work Conversation Messages and Attachments in the domain language.
- The API models post-Assignment Quest Edit consent through `quest_edit_request` and `quest_edit_request_response`.
- `disputeOverdueQuests` changes due Quests with incomplete proof or completion confirmation to `QUEST_DISPUTED`.

**Difference: `DOING-01` — Deadline extension contract**

The BPMN describes a Deadline extension with unanimous consent and a fallback to the original Deadline. The current API models a general Quest Edit request with a five-minute response window. The sources do not prove that these are the same operation. The target Deadline extension contract is not yet mapped to a current route or persistent record.

**Difference: `DOING-02` — group start behavior is unknown**

The API starts an assigned Quest when `start_time` is due. The sources do not define whether a GROUP Quest becomes `IN_PROGRESS` after the first Worker starts, after every Worker starts, or only through a Quest-level timer. The BPMN also does not define this result.

### 7. Draft, Final Proof, and Proof-free completion — D21 and D20

**Target ownership rules**

| Mode | Final Proof owner |
| --- | --- |
| FCFS + SOLO | The assigned Worker |
| FCFS + GROUP | Each assigned Worker |
| Candidate + SOLO | The selected Worker |
| Candidate + GROUP | The Team Leader for the selected Team |

Draft content is changeable Work Conversation content before Final Proof. Final Proof is sent through the Work Conversation and is the final submission for Hirer review.

**Current API baseline**

- `POST /api/v1/quests/:questId/proof` accepts a multipart Final Proof submission.
- `findOwner` identifies the individual Worker for SOLO and direct GROUP paths.
- For Candidate + GROUP, `findOwner` identifies the selected Team for any active selected Team Member.
- `submittedByUserId` records the Member who sent the proof.
- `POST /api/v1/quests/:questId/proof/confirm` records Proof-free completion confirmation.
- Proof or confirmation obligations are evaluated per Worker or per selected Team.
- Pending proof can be auto-approved after a mode-dependent period.

**Difference: `PROOF-01` — submission channel conflict**

The target decision is Work Conversation submission. The current API exposes a separate multipart `/proof` resource. The current route is not a Work Conversation Message route. This is a target/API contract difference.

**Difference: `PROOF-02` — Team proof authority conflict**

The target rule permits only the Team Leader to send Candidate + GROUP Final Proof. The current service permits any active selected Team Member to send the Team proof. The service records the actual sender, but it does not enforce Team Leader authority.

**Difference: `PROOF-03` — BPMN path missing**

The current API has a Proof-free path through `POST /api/v1/quests/:questId/proof/confirm`; the lifecycle worker later auto-approves due Proof-free Quests and settles them. No separate Hirer confirmation route is visible in the current route set. The BPMN diagrams do not show this path or the required join. The target BPMN must show Worker confirmations and the Hirer confirmation separately from Final Proof.

### 8. Settlement, Dispute, and closure — D20

**BPMN target**

- Hirer checks Final Proof against the Quest condition.
- A passing result settles Worker payment and then opens Review.
- A failed result enters an Admin path.
- Worker fault and Hirer fault have different payment and terminal Quest outcomes.

**Current API baseline**

- `POST /api/v1/quests/:questId/proof/:proofId/review` records the Hirer's proof decision.
- `POST /api/v1/quests/:questId/cancel` lets the Hirer cancel an `OPEN`, `ASSIGNED`, or `IN_PROGRESS` Quest with stage-specific reservation settlement.
- `POST /api/v1/admin/quests/:questId/dispute/resolve` lets an Admin refund the Hirer or release explicit integer-Satang allocations to Workers.
- Approved completion settles the Quest Escrow, pays each Worker the Quest Reward, applies the Platform Fee, marks Assignments completed, and changes the Quest to `QUEST_COMPLETED`.
- A refund result changes the Quest to `QUEST_CANCELLED`. A Worker release result changes it to `QUEST_COMPLETED`.

**Difference: `DISPUTE-01` — unresolved domain boundary**

`CONTEXT.md` defines a `Report Case` as a Trust & Safety case for one Work Conversation Message. The BPMN uses Report for no-show or failed Quest condition. The API uses `QUEST_DISPUTED` and Quest Settlement commands for overdue or payment outcomes. The comparison does not merge these concepts. The boundary and handoff between Chat moderation and Quest payment or performance Dispute remain unresolved.

**Difference: `SETTLE-01` — financial detail is not visible in BPMN**

The API distinguishes Quest Escrow, Quest Reward, Platform Fee, partial release, and refund. The BPMN names payment and refund branches but does not show these financial concepts or the exact stage-specific outcomes. The target BPMN needs named settlement results if those results are part of the business contract.

### 9. Review — D20

**BPMN target**

Review opens after the Quest closes successfully.

**Current API baseline**

- `POST /api/v1/quests/:questId/reviews` accepts a Review only when the Quest is `QUEST_COMPLETED`.
- Hirer and completed Workers can review the other direction.
- Each direction is allowed once per Quest.
- The completion window is seven days.

**Difference: `REVIEW-01` — order and timing**

The current API enforces `QUEST_COMPLETED` before Review creation. The BPMN order is not clear enough to prove the same sequence. The target must show `Settlement → QUEST_COMPLETED → Review`.

## Database documentation and migration comparison

### Database source inventory

The requested `docs/db/sql/` path is absent. The repository uses `docs/db/edr/*.sql` as its SQL documentation path. The Quest comparison therefore includes `docs/db/edr/05-quest.sql`, the shared `init.sql`, the identity document `01-auth.sql`, the Wallet document `02-wallet.sql`, the Money Policy document `03-payments.sql`, and the Profile document `04-profile.sql`.

The repository also contains Quest-related migrations `drizzle/0032_migrate_auth_ids_to_uuid.sql` through `drizzle/0041_team_disbanded_status.sql`. These files are evidence of intended and source-controlled migration steps. They are not evidence of the state of a deployed database.

### Structural alignment

| Area | Database evidence | Current API or runtime evidence | Result |
| --- | --- | --- | --- |
| Quest core | `05-quest.sql` defines the Quest modes, participation values, status values, Quest fields, checks, and indexes. | `src/database/schema/quest.schema.ts` and `src/modules/quest/quest.contract.ts` use the same core model. | The reviewed structure is aligned. |
| Teams, applications, and invitations | `05-quest.sql` defines `quest_team`, `quest_team_member`, `quest_team_invitation`, and `quest_application`. | Candidate routes and services use these tables and the same status vocabulary. | The reviewed structure is aligned, but the target Join Code is missing. |
| Commands and idempotency | `05-quest.sql` defines direct-join, Candidate-selection, and settlement command records. | The matching services require idempotency keys and write command, Assignment, Quest, and Work Conversation transitions in one transaction boundary. | Aligned at the persistence boundary. |
| Quest Escrow | `02-wallet.sql` deliberately has no Quest foreign key. It uses `caller_scope` and `caller_reference` on a generic Funding Reservation. | Quest publication and settlement use `callerScope: 'quest'` and the Quest ID, while Wallet owns reservation and fee ledger facts. | Aligned with ADR 0009. This is a generic ownership boundary, not a missing Quest FK. |
| Money Policy and Platform Fee | `03-payments.sql` stores versioned Money Policy, Platform Fee basis points, and rounding mode. | Quest publication and settlement read the snapshotted policy and calculate the Platform Fee. | Aligned. BPMN does not show this detail. |
| Team capacity and image caps | The SQL comments assign exact Team headcount, cross-Team deduplication, and the three-image Quest cap to the application layer. | The API checks exact headcount and uses `maxQuestImages = 3`. | Aligned responsibility. Direct SQL writers do not receive the API checks. |

### Database and API differences from the target

| ID | Class | Database or SQL evidence | Current API or runtime | Target or result |
| --- | --- | --- | --- | --- |
| `DBDOC-01` | Documentation conflict | `docs/db/edr/init.sql` says only migrations `0000..0008` are ahead of the SQL document and that Wallet, Payment, Quest, and Tag have no migrations. | The repository contains Quest migrations `0032..0041`; `05-quest.sql` also says the runtime Quest schema matches the EDR. | The DB status notes are stale or internally inconsistent. Refresh the notes. Do not infer the deployed database state from the repository. |
| `DBDOC-02` | Documentation conflict / boundary | `01-auth.sql` and `init.sql` describe all Auth identity IDs as native UUID and describe runtime Better Auth IDs as TEXT. | `auth_user.id` and `auth_admin.id` are UUID in the runtime schema; `auth_session.id`, `auth_account.id`, and `auth_verification.id` remain TEXT. The auth configuration sets Better Auth `generateId` to `uuid`. Migration `0032` changes user/admin IDs and foreign keys, not every Auth table's own ID. | Quest actor foreign keys use UUID correctly, but the shared Auth EDR does not match the current runtime model. |
| `DB-API-01` | Boundary / validation | Quest storage allows title length 200, description length 2,000, condition length 4,000, any positive reward, and any positive headcount. | Quest HTTP validation allows title 120, description 1,000, condition 1,000, reward up to 700,000 Satang, and headcount up to 20. | The API is stricter than the SQL storage contract. A direct SQL writer can create a Quest that the API cannot create or edit. Choose one canonical input limit or document the storage headroom. |
| `DB-API-02` | Conflicting behavior | D8 states a Bio limit of 2,000 characters. `01-auth.sql` documents `auth_user.bio` as `VARCHAR(1000)`. | Profile update validation accepts a Bio up to 1,000 characters; the runtime Auth schema uses unrestricted `text` for the column. | D8, the API, and SQL documentation disagree. Decide whether the canonical limit is 1,000 or 2,000, then align the validator and database document. |
| `DB-TARGET-01` | Conflicting behavior / missing behavior | `05-quest.sql` stores persisted targeted `quest_team_invitation` rows. There is no Join Code column, code table, or code validation contract. | Team formation exposes invitation create, accept, decline, and revoke routes. | The target Join Code flow is not represented in SQL or API. |
| `DB-TARGET-02` | Conflicting behavior | The `proof_submission` comment says a Team-owned submission records whichever Team Member submitted it. | `findOwner` permits any active selected Team Member to send Candidate + GROUP Final Proof. | The target requires the Team Leader to send Final Proof. SQL comments and API authority both differ. |
| `DB-TARGET-03` | Conflicting behavior / boundary | `05-quest.sql` defines `proof_submission` and `proof_submission_image`. Work Conversation is recorded as requirements only; Chat tables are not present. | Final Proof uses multipart `POST /api/v1/quests/:questId/proof`; the API has no Work Conversation message submission route. | The target Final Proof channel is Work Conversation. The current proof resource and SQL table are a separate channel. |
| `DB-TARGET-04` | Missing behavior / boundary | `QUEST_AWAITING_CONSENT` and `quest_edit_request` are explicitly for a post-Assignment Quest Edit. No pre-start consent entity or roster state exists. | The same post-Assignment Quest Edit consent is the only consent workflow exposed by the Quest service. | Pre-start Consent is not represented in the database or API. Keep it separate from Quest Edit consent. |
| `DB-TARGET-05` | Missing behavior | `quest_completion_confirmation` stores one Worker or Team obligation confirmation and `confirmed_by_user_id`; it has no separate Hirer confirmation obligation. | `/proof/confirm` accepts the Worker-side confirmation. Proof-free flow then uses lifecycle auto-approval and settlement; no separate Hirer confirmation route is visible. | The target requires Worker completion and Hirer confirmation. The current table and route do not represent both sides. |
| `DB-TARGET-06` | Conflicting behavior / unknown | `quest_status` includes `QUEST_REWORK`; `quest_application` and `quest_team` retain `rework_limit`; `proof_submission` derives rework usage. | The API accepts `QUEST_REWORK` and uses the stored rework limits. | Rework remains unresolved between BPMN, process rule, API, and SQL. Do not remove or change it silently. |
| `DB-BOUNDARY-01` | Missing behavior / runtime boundary | The SQL document records Work Conversation requirements only and says Chat tables and the writer adapter are later work. | Direct join and Candidate selection require a Work Conversation membership writer, but no writer configuration is present in `src/`; both paths fail closed with `503 WORK_CHAT_UNAVAILABLE`. | The database requirements and the API boundary are documented, but the target runtime transition is unavailable. |
| `DB-BOUNDARY-02` | Boundary / responsibility | SQL intentionally leaves exact Team count, cross-Team Member deduplication, and the three-image cap to application code. | Current services and schemas enforce those rules at API boundaries. | This is aligned by design, not a direct mismatch. It is a write-path risk if another service writes Quest rows without the same application checks. |
| `DB-DOC-TERM-01` | Terminology | `04-profile.sql` still says a profile tag comes from a Quest completed “as hunter” and mentions a “Giver/Hunter split”. | `CONTEXT.md` and current Quest code use `Hirer`, `Worker`, and `Team`. | SQL documentation still contains legacy domain terms. This does not change the current table shape, but it can mislead future implementation. |
| `DBDOC-03` | Documentation consistency | The top of `05-quest.sql` says rework fields and Proof Submission are “not yet walked”, while the same file later defines `quest_application`, `quest_team.rework_limit`, and `proof_submission`. | Runtime schema and migrations contain those structures. | Update the stale comments. The SQL document contradicts itself even where the table shape is present. |

### Database conclusion

The Quest EDR and the current Drizzle Quest schema are structurally close. The main database findings are not missing Quest tables in the current repository; they are stale DB status notes, a shared Auth documentation mismatch, API-versus-storage validation limits, and target behavior that is not modeled yet: Join Code, Team Leader-only Final Proof, Work Conversation Final Proof, separate Pre-start Consent, and separate Hirer confirmation.

The absence of `docs/db/sql/` is an inventory fact. The relevant SQL path is `docs/db/edr/`.

## Difference register

| ID | Class | Mode or phase | Target | Current API baseline | Status |
| --- | --- | --- | --- | --- | --- |
| `REG-01` | Conflicting behavior | D8 Registration | Bio accepts 2,000 characters | Profile API accepts 1,000; `01-auth.sql` documents `auth_user.bio` as `VARCHAR(1000)`. | Align the canonical Bio limit. |
| `DBDOC-01` | Documentation conflict | Database migration status | Current Quest migration chain is documented | `init.sql` says Quest has no migration and only `0000..0008` are current. | Refresh status notes; live DB state is unknown. |
| `DBDOC-02` | Documentation conflict / boundary | Shared Auth identity | Quest actor IDs are native UUID | EDR says all Auth IDs are UUID, but runtime session/account/verification IDs remain TEXT. | Align the Auth EDR with runtime and migration scope. |
| `DB-API-01` | Boundary / validation | Quest creation and edit | One input contract | SQL storage is wider than HTTP validation for text, reward, and headcount. | Decide whether SQL headroom is intentional. |
| `DB-DOC-TERM-01` | Terminology | Profile tag derivation | `Hirer`, `Worker` | `04-profile.sql` still uses `Giver` and `Hunter`. | Update SQL comments to canonical terms. |
| `VOC-01` | Terminology | All | `Hirer` and `Worker` | Routes and Quest services use Hirer and Worker. | Aligned after glossary cleanup. |
| `VOC-02` | Terminology | Candidate + GROUP | `Team`, Team Leader, Team Member | Schema and routes use `quest_team`; BPMN uses Group. | Team is canonical. Group is the BPMN label for the same concept. |
| `MONEY-01` | Terminology / boundary | Publication and settlement | Quest Escrow or Funding Reservation | Publish creates Quest Escrow; Wallet owns reserved funds. | BPMN “debit” needs precise wording. |
| `TEAM-01` | Conflicting behavior / missing behavior | Candidate + GROUP Team Setup | Join Code | Targeted in-app Team Invitation, 24-hour expiry, no Join Code field. | Target/API gap. |
| `TEAM-02` | Boundary / unknown behavior | Candidate + GROUP Team Setup | Full Team reaches Hirer selection | Team Leader must explicitly submit a full Team. | Define whether full capacity auto-submits. |
| `CONSENT-01` | Missing behavior / boundary | `ASSIGNED` before Quest Doing | Separate Pre-start Consent; Candidate + `SOLO` and Candidate + `GROUP` cannot start until all required Members consent | Only Quest Edit consent is modeled with `QUEST_AWAITING_CONSENT`. | Target rule is clear; API contract is missing. |
| `DOING-01` | Boundary / unknown behavior | Quest Doing | Unanimous Deadline extension | General Quest Edit request with a five-minute response window. | Map or separate the operations. |
| `DOING-02` | Unknown behavior | GROUP Quest Doing | Named group start rule | Worker start is scheduled from `start_time`; Quest-level partial-start result is not defined. | Open. |
| `PROOF-01` | Conflicting behavior | Final Proof | Work Conversation submission | Multipart `POST /:questId/proof` resource. | Target/API contract gap. |
| `PROOF-02` | Conflicting behavior | Candidate + GROUP completion | Team Leader only | Any active selected Team Member can submit for the selected Team. | Target/API authority gap. |
| `PROOF-03` | Missing behavior | Proof-free completion | Visible Worker-confirmation join and Hirer confirmation | `POST /:questId/proof/confirm` and completion confirmation records exist; the lifecycle worker auto-approves due Proof-free Quests, with no separate Hirer confirmation route visible. | BPMN path and explicit API confirmation boundary need alignment. |
| `REWORK-01` | Conflicting behavior / unknown | D20 completion | Unresolved | D20 shows Rework; process rule excludes it; API and schema retain `QUEST_REWORK` and `rework_limit`. | Do not resolve silently. |
| `DISPUTE-01` | Boundary / unknown behavior | D21 → D20 | Unresolved | `Report Case`, `QUEST_DISPUTED`, and settlement commands have different current meanings. | Define the handoff. |
| `SETTLE-01` | Missing behavior | D20 settlement | Named Worker/Hirer fault outcomes | API performs stage-specific cancellation and Admin allocation settlement. | Add exact financial outcomes to target. |
| `REVIEW-01` | Conflicting behavior | D20 closure | Review after completion | API requires `QUEST_COMPLETED` before Review. | Target sequence must be explicit. |

## What is aligned

- The role that creates a Quest is the Hirer.
- The role accepted to work is the Worker.
- Candidate and direct FCFS selection are separate paths.
- `FCFS` maps to `NO_CANDIDATE`.
- `Candidate` maps to `CANDIDATE`.
- `SOLO` and `GROUP` are independent participation choices.
- A complete Candidate Team is selected by the Hirer before Assignment.
- Direct GROUP join reaches Assignment at exact headcount.
- Quest Escrow is created before publication.
- `start_time` controls the earliest start transition.
- Proof-free completion is represented in the API.
- Quest and Wallet money ownership is separated.
- Terminal Quest states make the Work Conversation read-only.

## Open decisions retained

These items remain open by decision. The comparison records them instead of guessing:

1. Whether the D20 Rework branch is target behavior or stale BPMN content.
2. Whether `QUEST_REWORK` and `rework_limit` remain as legacy data.
3. Whether a full Candidate Team becomes `TEAM_SUBMITTED` automatically or needs Team Leader submission.
4. Join Code length, security, expiry, and regeneration behavior.
5. The Pre-start Consent failure result, persistent state, consent text, and whether the Hirer is in the required roster.
6. The Quest-level transition when only some GROUP Workers press Start Work.
7. The boundary and handoff between a Work Conversation `Report Case` and a Quest payment or performance Dispute.
8. The exact target settlement data that BPMN must display.

## Glossary changes

`CONTEXT.md` now records these canonical terms for this comparison:

- `Hirer` and `Worker` are the only current Quest role terms.
- `Team`, `Team Leader`, and `Team Member` are canonical. BPMN `Group` labels are avoided for the domain entity.
- `Draft` is Work Conversation content before Final Proof.
- `Final Proof` is the final submission sent through the Work Conversation for Hirer review.
- `Pre-start Consent` is separate from Quest Edit consent. Candidate Quests cannot start until all required Members consent; the roster and failure result remain open.

The older `Giver` and `Hunter` definitions were removed. They remain only as avoided legacy words under the canonical Quest terms.

## Evidence limits

- BPMN D labels are inferred from board order. Widget IDs are the stable references.
- The BPMN audit could not recover semantic edge data for every connector.
- The current comparison uses schema and source code. It does not use live PostgreSQL rows.
- A current API route or schema field proves current implementation behavior or shape. It does not by itself prove the intended business rule.
- The SQL comparison covers repository documents and migration files. It does not inspect live PostgreSQL schema, rows, or applied migration history.
