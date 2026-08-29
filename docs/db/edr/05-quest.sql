-- ==================== quest_core (Quest Core) ====================
-- BE-170 revision (2026-08-27): canonical domain contracts applied —
--  - Hirer/Worker vocabulary on physical columns: hirer_id/worker_id
--    (renamed from the old Giver/Hunter column names). Member identity is
--    native UUID auth_user.id, Admin identity native UUID auth_admin.id (see
--    01-auth.sql).
--  - Every status value is entity-prefixed: QUEST_*, TEAM_*, APPLICATION_*,
--    ASSIGNMENT_*, PROOF_*, EDIT_REQUEST_*, EDIT_RESPONSE_*, INVITATION_*.
--    QUEST_AWAITING_CONSENT and APPLICATION_WITHDRAWN are new values.
--  - quest_location is label-only; the quest_image cap is 3.
--  - Persisted team invitations added (quest_team_invitation).
--  - Dedicated Work Conversation requirements recorded at the bottom of this
--    file (documentation only — Chat tables and the writer adapter are a later
--    ticket, BE-174).
-- The runtime Drizzle schema and Quest persistence adapter use this vocabulary;
-- the post-Assignment edit consent workflow is implemented by BE-175. Direct
-- NO_CANDIDATE joins and Assignment creation are implemented by BE-181.
-- Candidate selection and Assignment fan-out are implemented by BE-180.
--
-- Target workflow note: use docs/quest/work-chat-system-target.md for the
-- accepted Work Chat and Quest workflow. Reconcile workflow-specific values in
-- this EDR before implementation when they differ from that target.
--
-- Core quest table settled via /batch-grill-me. Old Quest model (prisma.ts) split/trimmed:
--  - riskLevel/riskCheckedAt: cut, no consumer anywhere in the schema, no product
--    requirement surfaced for it — revisit only if a moderation module needs it.
--  - reworkAllowed/reworkLimit: cut from quest entirely — rework count is proposed by
--    the Worker, not set by the Hirer, so it belongs on QuestApplication/QuestAssignment
--    (not yet walked), not here.
--  - reworkUsed: cut as a stored column — will be derived from ProofSubmission
--    (count of rework-triggering rejections) once that table is walked. Same
--    derive-don't-store pattern as profile's tag derivation.
--  - description vs condition: split in two. description is free narrative (nullable);
--    condition is the explicit pass/fail criteria proof gets judged against — always
--    required, since ambiguity here is exactly what feeds disputes.
--  - teamId: gone (see quest_team below — ownership direction inverted from old
--    Quest.teamId UNIQUE to quest_team.quest_id non-unique).
--
-- mode/participation/status: native Postgres ENUM, isolated experiment (2026-08-07, via
-- /grilling) against the schema-wide VARCHAR+CHECK convention used everywhere else (44
-- other tables, including quest's own siblings quest_team.team_status/
-- quest_application.application_status/proof_submission.submission_status/
-- quest_team_invitation.invitation_status). NOT yet a
-- standing pattern — don't convert other tables off
-- the back of this without a separate decision. Trade-off accepted: adding a new status
-- value later needs ALTER TYPE ... ADD VALUE (can't run inside the same transaction as
-- code that uses the new value, pre-PG12 also couldn't run in a transaction at all) versus
-- VARCHAR+CHECK's plain DROP/ADD CONSTRAINT — status is the most volatile column here
-- (quest lifecycle, most likely to grow a value), so this is the sharpest test of whether
-- that cost is worth it.
--
-- QUEST_AWAITING_CONSENT: the Quest pauses while a Hirer's post-Assignment edit
-- request (quest_edit_request) awaits Worker consent. It is entered only after
-- Assignment exists (QUEST_ASSIGNED onward) and the Quest returns to its prior
-- stage when the request resolves. It is NOT selected-Candidate consent before
-- Assignment creation, and NOT an under-fill state — exact team headcount is
-- required before team submission/selection (see quest_team).
CREATE TYPE quest_mode AS ENUM ('NO_CANDIDATE', 'CANDIDATE');
CREATE TYPE quest_participation AS ENUM ('SOLO', 'GROUP');
CREATE TYPE quest_status AS ENUM ('QUEST_DRAFT', 'QUEST_OPEN', 'QUEST_AWAITING_CONSENT',
                                   'QUEST_ASSIGNED', 'QUEST_IN_PROGRESS', 'QUEST_SUBMITTED',
                                   'QUEST_APPROVED', 'QUEST_REWORK', 'QUEST_COMPLETED',
                                   'QUEST_CANCELLED', 'QUEST_DISPUTED', 'QUEST_HIDDEN');

CREATE TABLE quest (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hirer_id     UUID NOT NULL REFERENCES auth_user(id),
  title        VARCHAR(200) NOT NULL,
  description  VARCHAR(2000),
  condition    VARCHAR(4000) NOT NULL,
  mode         quest_mode NOT NULL,
  participation quest_participation NOT NULL DEFAULT 'SOLO',
  quest_status quest_status NOT NULL DEFAULT 'QUEST_DRAFT',
  reward_satang  INTEGER NOT NULL CHECK (reward_satang > 0),
  -- Set at publish. These values freeze the Quest funding terms and identify
  -- the Funding Reservation used by later settlement commands.
  funding_reservation_id UUID UNIQUE REFERENCES wallet_funding_reservations(id),
  policy_revision_id UUID REFERENCES payment_money_policy_revisions(id),
  platform_fee_bps SMALLINT CHECK (platform_fee_bps IS NULL OR platform_fee_bps BETWEEN 0 AND 10000),
  platform_fee_per_worker_satang INTEGER CHECK (platform_fee_per_worker_satang IS NULL OR platform_fee_per_worker_satang >= 0),
  quest_escrow_satang INTEGER CHECK (quest_escrow_satang IS NULL OR quest_escrow_satang > 0),
  tag_id       UUID REFERENCES tag(id),
  headcount    INTEGER NOT NULL DEFAULT 1 CHECK (headcount > 0),
  start_time   TIMESTAMPTZ NOT NULL,
  due_at       TIMESTAMPTZ,
  proof_required BOOLEAN NOT NULL DEFAULT true,
  cancelled_at TIMESTAMPTZ,
  cancelled_by_user_id  UUID REFERENCES auth_user(id),
  cancelled_by_admin_id UUID REFERENCES auth_admin(id),
  -- QUEST_HIDDEN is moderation only: an admin unlists a published quest, escrow stays held,
  -- and the quest can go back to QUEST_OPEN (which clears these). Hirers cannot hide their
  -- own quest — they cancel it. Hence admin-only, unlike cancelled_by_*, which is
  -- polymorphic because a Hirer can cancel too. Reason text belongs to Trust & Safety,
  -- not here.
  hidden_at    TIMESTAMPTZ,
  hidden_by_admin_id UUID REFERENCES auth_admin(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- SOLO quests always have exactly one slot; GROUP sizing is checked at team-submit time (app-layer)
  CHECK (participation = 'GROUP' OR headcount = 1),
  CHECK (due_at IS NULL OR due_at > start_time),
  -- draft quests can be tagless while the Hirer is still filling the form
  CHECK (quest_status = 'QUEST_DRAFT' OR tag_id IS NOT NULL),
  CHECK (num_nonnulls(cancelled_by_user_id, cancelled_by_admin_id) <= 1),
  CHECK ((cancelled_at IS NULL) = (quest_status <> 'QUEST_CANCELLED')),
  CHECK ((hidden_at IS NULL) = (quest_status <> 'QUEST_HIDDEN')),
  CHECK ((hidden_by_admin_id IS NULL) = (hidden_at IS NULL))
);
CREATE INDEX quest_hirer_id_idx ON quest (hirer_id);
CREATE INDEX quest_status_idx ON quest (quest_status);
CREATE INDEX quest_mode_idx ON quest (mode);
CREATE INDEX quest_tag_id_idx ON quest (tag_id);
CREATE INDEX quest_start_time_idx ON quest (start_time);

-- Review is available after a Quest is QUEST_COMPLETED. A Hirer may review each
-- completed Worker Assignment and each completed Worker may review the Hirer, once
-- per direction per Quest. Reviews are immediately visible, and the author may
-- edit rating/comment until seven days after Quest completion; Reviews cannot be
-- deleted. Profile Reputation is the equal-weight average of valid received
-- Reviews; no received Reviews means average NULL and count/distribution zero.
CREATE TABLE review (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quest_id    UUID NOT NULL REFERENCES quest(id),
  reviewer_id UUID NOT NULL REFERENCES auth_user(id),
  reviewee_id UUID NOT NULL REFERENCES auth_user(id),
  rating      SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment     VARCHAR(1000),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (reviewer_id <> reviewee_id),
  UNIQUE (quest_id, reviewer_id, reviewee_id)
);
CREATE INDEX review_quest_id_idx ON review (quest_id);
CREATE INDEX review_reviewee_id_idx ON review (reviewee_id);

-- quest_location: where the quest happens. Label-only (BE-170): a location is a
-- free-text label, no address/geocode columns — no reverse-geocoded data is
-- stored, so there is nothing to go stale or leak. The label stays nullable:
-- zero location rows at all is valid and stays valid at publish (online-only
-- quests — design, tutoring over video — are real), and a row that does exist
-- may carry a null label. Edits after a Worker or team is selected go through
-- quest_edit_request like any other quest field — no separate consent
-- mechanism for locations.
CREATE TABLE quest_location (
  id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quest_id UUID NOT NULL REFERENCES quest(id) ON DELETE CASCADE,
  label    VARCHAR(100)
);
CREATE INDEX quest_location_quest_id_idx ON quest_location (quest_id);

-- quest_image: gallery on the quest detail screen (SRS 3.3, FE-27 step 1).
-- Same shape as profile_portfolio_item_image — file reference + ordered position,
-- never a stored storage URL. Deliberately NOT shown on the Quest Board card
-- (ADR 0001 keeps the card image-free for density), so this is detail-screen only.
-- Zero rows is valid; the per-quest cap is 3 (BE-170), app-layer — the Quest
-- module already enforces it (maxQuestImages).
CREATE TABLE quest_image (
  id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quest_id UUID NOT NULL REFERENCES quest(id) ON DELETE CASCADE,
  file_id  UUID NOT NULL REFERENCES file(id),
  position INTEGER NOT NULL DEFAULT 0,
  UNIQUE (quest_id, position)
);
CREATE INDEX quest_image_quest_id_idx ON quest_image (quest_id);

-- ==================== quest_lifecycle (Quest Lifecycle) ====================
-- quest_edit_request: consent gate for edits made after a Worker or team is selected or
-- work is QUEST_IN_PROGRESS (per Quest Timeline spec — pre-selection edits go straight
-- to quest_edit_history, no consent needed). requested_by is always the Hirer. The
-- previous status and response rows snapshot the Quest state and Active Workers at
-- request creation, so roster changes cannot alter who must consent.
CREATE TABLE quest_edit_request (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quest_id     UUID NOT NULL REFERENCES quest(id) ON DELETE CASCADE,
  requested_by_user_id UUID NOT NULL REFERENCES auth_user(id),
  proposed_changes JSONB NOT NULL,
  previous_quest_status quest_status NOT NULL,
  request_status VARCHAR(32) NOT NULL DEFAULT 'EDIT_REQUEST_PENDING'
                 CHECK (request_status IN ('EDIT_REQUEST_PENDING', 'EDIT_REQUEST_APPROVED', 'EDIT_REQUEST_REJECTED')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at  TIMESTAMPTZ
);
CREATE INDEX quest_edit_request_quest_idx ON quest_edit_request (quest_id);
CREATE UNIQUE INDEX quest_edit_request_one_pending_uidx ON quest_edit_request (quest_id)
  WHERE request_status = 'EDIT_REQUEST_PENDING';

-- one row per Worker who must consent (all of them, for GROUP), created at request
-- time to snapshot the roster. A null decision means the Worker has not responded;
-- unanimous approval is required. A single EDIT_RESPONSE_REJECTED fails the whole
-- request immediately (fail-fast), not waited out
CREATE TABLE quest_edit_request_response (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id   UUID NOT NULL REFERENCES quest_edit_request(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL REFERENCES auth_user(id),
  decision     VARCHAR(32)
               CHECK (decision IN ('EDIT_RESPONSE_APPROVED', 'EDIT_RESPONSE_REJECTED')),
  responded_at TIMESTAMPTZ,
  UNIQUE (request_id, user_id)
);
CREATE INDEX quest_edit_request_response_request_idx ON quest_edit_request_response (request_id);

-- append-only field-diff log. Covers both direct edits (QUEST_OPEN / pre-candidate
-- stages, edit_request_id NULL) and edits applied after quest_edit_request approval
-- (edit_request_id set, for traceability). 5-minute post-edit cooldown before a
-- candidate can be selected (Quest Timeline spec) is derived at read time from
-- MAX(edited_at) here — a derived edit deadline, never snapshotted as a quest column.
CREATE TABLE quest_edit_history (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quest_id     UUID NOT NULL REFERENCES quest(id) ON DELETE CASCADE,
  edit_request_id UUID REFERENCES quest_edit_request(id),
  field_name   VARCHAR(100) NOT NULL,
  old_value    JSONB,
  new_value    JSONB,
  edited_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  edited_by_user_id  UUID REFERENCES auth_user(id),
  edited_by_admin_id UUID REFERENCES auth_admin(id),
  CHECK (num_nonnulls(edited_by_user_id, edited_by_admin_id) <= 1)
);
CREATE INDEX quest_edit_history_quest_idx ON quest_edit_history (quest_id, edited_at);

-- ==================== quest_team (team formation, GROUP+CANDIDATE only) (Quest Application & Fulfillment) ====================
-- Settled via /grilling + /batch-grill-me interview.
-- quest_team/quest_team_member exist only for QuestParticipation=GROUP +
-- QuestMode=CANDIDATE. For GROUP + NO_CANDIDATE (join-until-headcount-reached),
-- no team identity is created — plain QuestAssignment rows against
-- Quest.headcount, same mechanism as SOLO+NO_CANDIDATE.

-- rework_limit: Worker-proposed rework cap, proposed once by the leader for the
-- whole team (rework quota is shared across the team, not per-member — settled
-- during the QuestApplication/QuestAssignment walk). reworkUsed is NOT stored
-- here — derives from ProofSubmission once that table is walked, same
-- derive-don't-store pattern used elsewhere.
CREATE TABLE quest_team (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quest_id      UUID NOT NULL REFERENCES quest(id) ON DELETE CASCADE,
  leader_id     UUID NOT NULL REFERENCES auth_user(id),
  name          VARCHAR(100) NOT NULL,
  team_status   VARCHAR(32) NOT NULL DEFAULT 'TEAM_FORMING'
                CHECK (team_status IN ('TEAM_FORMING', 'TEAM_SUBMITTED', 'TEAM_SELECTED', 'TEAM_REJECTED', 'TEAM_DISBANDED')),
  rework_limit  INTEGER NOT NULL DEFAULT 0 CHECK (rework_limit >= 0),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- (id, leader_id) is trivially unique (id is the PK); declared so
  -- quest_team_invitation can carry a composite FK proving invited_by_user_id
  -- is that team's leader at DB level — no denormalization, no app-layer gap.
  UNIQUE (id, leader_id)
);
CREATE INDEX quest_team_quest_id_idx ON quest_team (quest_id);
-- enforces "only one team ever works a quest" at DB level; auto-rejecting
-- competing teams on selection is still an app-layer transaction, this is the safety net
CREATE UNIQUE INDEX quest_team_one_selected_uidx ON quest_team (quest_id) WHERE team_status = 'TEAM_SELECTED';

-- leader has a row here too (counts toward headcount), written directly at team
-- creation; every other member's row is created only when they accept a
-- quest_team_invitation, in the same transaction. Exact team headcount is
-- required before submission and selection: a TEAM_FORMING team may
-- transiently over/under-fill while forming, but it may not become
-- TEAM_SUBMITTED (nor be selected) until its member count equals
-- Quest.headcount — checked at submit time, app-layer (not a DB constraint).
-- QUEST_AWAITING_CONSENT is not an under-fill state and never stands in for
-- this rule. Cross-team dedup within the same quest (one Member, one team per
-- quest) is also app-layer: quest_team_member doesn't carry quest_id, so a
-- DB-level partial unique index would need denormalizing quest_id (+ status)
-- down from quest_team, trading a sync-risk for a constraint that's only ever
-- checked at a single insert point — not worth it here.
-- FORMING Team membership can change before submission. A Member can leave, a
-- Team Leader can remove a Member, leadership transfers to the earliest joined
-- remaining Member when the Leader leaves, and a Team with no remaining
-- members becomes TEAM_DISBANDED. TEAM_DISBANDED Teams are retained for audit
-- but are not active Candidates and cannot be submitted or selected.
CREATE TABLE quest_team_member (
  team_id   UUID NOT NULL REFERENCES quest_team(id) ON DELETE CASCADE,
  user_id   UUID NOT NULL REFERENCES auth_user(id),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, user_id)
);
CREATE INDEX quest_team_member_user_id_idx ON quest_team_member (user_id);

-- quest_team_invitation: persisted team invitations (BE-170). Exists only where
-- quest_team exists — GROUP+CANDIDATE — so that scope is inherited, not re-stated.
-- A Team Leader invites a Member; the Member accepts or declines; the Leader may
-- revoke while pending. A quest_team_member row is created ONLY on acceptance,
-- in the same transaction. Pending invitations expire after 24 hours:
-- expires_at is fixed at insert as created_at + interval '24 hours' (a fixed
-- SLA, not a versioned policy value) and is pure data — expiry is applied ONLY
-- by the scheduled background worker, which flips INVITATION_PENDING to
-- INVITATION_EXPIRED (stamping responded_at) once expires_at has passed; API
-- reads never mutate invitation status, so a not-yet-swept invitation reads as
-- INVITATION_PENDING with a past expires_at. The invited Member must not
-- already hold membership on any team for the same quest — app-layer, same
-- cross-team dedup stance as quest_team_member above.
CREATE TABLE quest_team_invitation (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id            UUID NOT NULL,
  invited_user_id    UUID NOT NULL REFERENCES auth_user(id),
  invited_by_user_id UUID NOT NULL,
  invitation_status  VARCHAR(32) NOT NULL DEFAULT 'INVITATION_PENDING'
                     CHECK (invitation_status IN ('INVITATION_PENDING', 'INVITATION_ACCEPTED', 'INVITATION_DECLINED', 'INVITATION_EXPIRED', 'INVITATION_REVOKED')),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  responded_at       TIMESTAMPTZ,
  expires_at         TIMESTAMPTZ NOT NULL,
  CHECK (expires_at > created_at),
  -- responded_at is set exactly when the invitation leaves INVITATION_PENDING
  -- (Member response, expiry flip, or revocation)
  CHECK ((responded_at IS NULL) = (invitation_status = 'INVITATION_PENDING')),
  -- invited_by_user_id is the historical leader who sent the invitation. The
  -- current Team Leader can change when the prior leader leaves, so this audit
  -- field deliberately does not carry a composite FK to quest_team.leader_id.
  FOREIGN KEY (team_id) REFERENCES quest_team (id) ON DELETE CASCADE
);
CREATE INDEX quest_team_invitation_team_id_idx ON quest_team_invitation (team_id);
CREATE INDEX quest_team_invitation_invited_user_id_idx ON quest_team_invitation (invited_user_id);
-- one live invitation per Member per team — after decline/expiry/revocation a
-- fresh invitation may be issued
CREATE UNIQUE INDEX quest_team_invitation_one_pending_uidx ON quest_team_invitation (team_id, invited_user_id) WHERE invitation_status = 'INVITATION_PENDING';

-- ==================== quest_application (SOLO+CANDIDATE only) (Quest Application & Fulfillment) ====================
-- Settled via /batch-grill-me interview. quest_application exists only for
-- QuestParticipation=SOLO + QuestMode=CANDIDATE — GROUP+CANDIDATE never
-- creates rows here, it goes through quest_team instead. Old QuestApplication
-- (prisma.ts:233) shape kept close to as-is: no new fields added (YAGNI —
-- nothing in either session's interview called for one, e.g. no cover-note).
--
-- APPLICATION_WITHDRAWN (BE-170): the Candidate withdraws their own
-- application before selection. It is pre-selection only — once
-- APPLICATION_SELECTED, the Candidate has become a Worker and this platform
-- has no voluntary post-selection leave (see the ASSIGNMENT_INCOMPLETE note on
-- quest_assignment).
--
-- rework_limit: Worker-proposed rework cap, proposed at apply time (before
-- selection) — for SOLO this is per-individual (contrast quest_team.rework_limit,
-- which is one shared value for the whole team). reworkUsed is NOT stored here —
-- derives from ProofSubmission once that table is walked, same
-- derive-don't-store pattern used elsewhere.
CREATE TABLE quest_application (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quest_id     UUID NOT NULL REFERENCES quest(id) ON DELETE CASCADE,
  worker_id    UUID NOT NULL REFERENCES auth_user(id),
  application_status VARCHAR(32) NOT NULL DEFAULT 'APPLICATION_APPLIED'
                CHECK (application_status IN ('APPLICATION_APPLIED', 'APPLICATION_SELECTED', 'APPLICATION_REJECTED', 'APPLICATION_WITHDRAWN')),
  rework_limit INTEGER NOT NULL DEFAULT 0 CHECK (rework_limit >= 0),
  applied_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (quest_id, worker_id)
);
CREATE INDEX quest_application_quest_id_idx ON quest_application (quest_id);
CREATE INDEX quest_application_status_idx ON quest_application (application_status);
-- same "only one ever selected" safety net as quest_team_one_selected_uidx
CREATE UNIQUE INDEX quest_application_one_selected_uidx ON quest_application (quest_id) WHERE application_status = 'APPLICATION_SELECTED';

-- ==================== quest_assignment (universal roster, all 4 mode×participation combos) (Quest Application & Fulfillment) ====================
-- Settled via /batch-grill-me interview. The single "who is actually working
-- this quest" table across every combo: NO_CANDIDATE direct-joiners (SOLO or
-- GROUP, up to Quest.headcount — headcount-vs-joined-count enforcement is
-- app-layer, same precedent as quest_team size-vs-headcount, not a DB
-- constraint), SOLO+CANDIDATE's selected applicant, and GROUP+CANDIDATE's
-- selected team's members (one row per member, fanned out at selection time).
--
-- Deliberately does NOT store, vs old QuestAssignment (prisma.ts:246):
--  - team_id / application_id (origin traceability) — always derivable via
--    (quest_id, worker_id) join back to quest_team_member / quest_application;
--    NO_CANDIDATE rows have no origin row at all, so a stored FK would be
--    null there regardless. Same derive-don't-store call as reworkUsed.
--  - escrowLocked — derives from wallet_activities (resource_type =
--    'quest_assignment', resource_id = this row's id) instead of a
--    denormalized boolean; wallet_activities already carries the generic
--    resource_type/resource_id hooks for exactly this.
--  - rework_limit — moved to quest_application (SOLO+CANDIDATE) / quest_team
--    (GROUP+CANDIDATE), since it's proposed by the applying party at
--    commit-to-quest time, which predates and is separate from this table's
--    row (created at selection/join time). NULL/unused for NO_CANDIDATE.
--  - submittedAt / approvedAt — these are proof-review timestamps, belong on
--    ProofSubmission once that table is walked, not duplicated here.
--
-- assignment_status: old schema had only a boolean `uncomplete` + timestamps, no real
-- status field. Replaced with an explicit status column, consistent with the
-- quest.quest_status / quest_team.team_status convention:
--  - ASSIGNMENT_ACTIVE: default, currently working.
--  - ASSIGNMENT_COMPLETED: proof approved, quest fulfilled by this Worker.
--  - ASSIGNMENT_INCOMPLETE: Worker failed to deliver (no-show / never finished /
--    proof rejected with no rework left) — this platform has no voluntary
--    post-selection leave (confirmed: team members can't leave after
--    selection), so this is always a failure state attributable to the
--    Worker, the future home for the deferred Worker "red flag" behavior.
--  - ASSIGNMENT_CANCELLED: assignment ended because the quest itself was cancelled —
--    explicitly NOT the Worker's fault, kept distinct from ASSIGNMENT_INCOMPLETE so
--    penalty/red-flag logic can tell the two apart.
CREATE TABLE quest_assignment (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quest_id   UUID NOT NULL REFERENCES quest(id) ON DELETE CASCADE,
  worker_id  UUID NOT NULL REFERENCES auth_user(id),
  assignment_status VARCHAR(32) NOT NULL DEFAULT 'ASSIGNMENT_ACTIVE'
             CHECK (assignment_status IN ('ASSIGNMENT_ACTIVE', 'ASSIGNMENT_COMPLETED', 'ASSIGNMENT_INCOMPLETE', 'ASSIGNMENT_CANCELLED')),
  started_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (quest_id, worker_id)
);
CREATE INDEX quest_assignment_quest_id_idx ON quest_assignment (quest_id);
CREATE INDEX quest_assignment_worker_id_idx ON quest_assignment (worker_id);
CREATE INDEX quest_assignment_status_idx ON quest_assignment (assignment_status);

-- Direct joins use durable command identity so retries replay the original
-- Assignment and Quest result. The row is created as PROCESSING and completed
-- in the same Quest transaction as the Assignment, Quest transition, and Chat
-- transition. A failed transaction leaves no command row, so the command may
-- be retried. command_id is globally unique for direct-join commands: reuse
-- with another Worker, Quest, or request fingerprint is rejected.
CREATE TABLE quest_direct_join_commands (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  command_id         VARCHAR(200) NOT NULL UNIQUE,
  worker_id          UUID NOT NULL REFERENCES auth_user(id),
  quest_id           UUID NOT NULL REFERENCES quest(id) ON DELETE CASCADE,
  request_hash       VARCHAR(64) NOT NULL,
  assignment_id      UUID UNIQUE REFERENCES quest_assignment(id) ON DELETE CASCADE,
  result_assignment_status VARCHAR(32),
  result_started_at   TIMESTAMPTZ,
  result_created_at   TIMESTAMPTZ,
  result_quest_status quest_status,
  processing_status  VARCHAR(32) NOT NULL DEFAULT 'PROCESSING'
                     CHECK (processing_status IN ('PROCESSING', 'COMPLETED')),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at       TIMESTAMPTZ,
  CHECK ((processing_status = 'COMPLETED') = (completed_at IS NOT NULL)),
  CHECK (processing_status = 'PROCESSING' OR (assignment_id IS NOT NULL AND result_assignment_status IS NOT NULL AND result_created_at IS NOT NULL AND result_quest_status IS NOT NULL))
);
CREATE INDEX quest_direct_join_commands_quest_id_idx ON quest_direct_join_commands (quest_id);
CREATE INDEX quest_direct_join_commands_worker_id_idx ON quest_direct_join_commands (worker_id);

-- Candidate selections use durable command identity so retries replay the complete
-- accepted roster. The command is completed in the same transaction as Candidate
-- status changes, Assignments, Quest transition, and Work Chat transition.
CREATE TABLE quest_candidate_selection_commands (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  command_id            VARCHAR(200) NOT NULL UNIQUE,
  hirer_id              UUID NOT NULL REFERENCES auth_user(id),
  quest_id              UUID NOT NULL REFERENCES quest(id) ON DELETE CASCADE,
  target_type           VARCHAR(32) NOT NULL CHECK (target_type IN ('APPLICATION', 'TEAM')),
  target_id             UUID NOT NULL,
  request_hash          VARCHAR(64) NOT NULL,
  result_assignment_ids JSONB,
  result_quest_status   quest_status,
  processing_status     VARCHAR(32) NOT NULL DEFAULT 'PROCESSING'
                        CHECK (processing_status IN ('PROCESSING', 'COMPLETED')),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at          TIMESTAMPTZ,
  CHECK ((processing_status = 'COMPLETED') = (completed_at IS NOT NULL)),
  CHECK (processing_status = 'PROCESSING' OR (result_assignment_ids IS NOT NULL AND result_quest_status IS NOT NULL))
);
CREATE INDEX quest_candidate_selection_commands_quest_id_idx ON quest_candidate_selection_commands (quest_id);
CREATE INDEX quest_candidate_selection_commands_hirer_id_idx ON quest_candidate_selection_commands (hirer_id);

-- Terminal settlement commands keep cancellation, completion, and Admin dispute
-- resolution replay-safe. actor_user_id is the Hirer for Member commands;
-- actor_admin_id is the Admin for dispute commands. Custom dispute allocation
-- uses the generic Wallet settlement operation with no invented Platform Fee;
-- unallocated reservation funds are released back to the Hirer.
CREATE TABLE quest_settlement_commands (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  command_id         VARCHAR(200) NOT NULL UNIQUE,
  quest_id           UUID NOT NULL REFERENCES quest(id) ON DELETE CASCADE,
  actor_user_id      UUID REFERENCES auth_user(id),
  actor_admin_id     UUID REFERENCES auth_admin(id),
  command_type       VARCHAR(32) NOT NULL CHECK (command_type IN ('COMPLETE', 'CANCEL', 'DISPUTE_REFUND', 'DISPUTE_RELEASE', 'AUTO_CANCEL')),
  request_hash       VARCHAR(64) NOT NULL,
  result_data        JSONB,
  processing_status  VARCHAR(32) NOT NULL DEFAULT 'PROCESSING' CHECK (processing_status IN ('PROCESSING', 'COMPLETED')),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at       TIMESTAMPTZ,
  -- AUTO_CANCEL is a system command and has no Hirer or Admin actor.
  CHECK ((command_type = 'AUTO_CANCEL' AND num_nonnulls(actor_user_id, actor_admin_id) = 0)
      OR (command_type <> 'AUTO_CANCEL' AND num_nonnulls(actor_user_id, actor_admin_id) = 1)),
  CHECK ((processing_status = 'COMPLETED') = (completed_at IS NOT NULL)),
  CHECK (processing_status = 'PROCESSING' OR result_data IS NOT NULL)
);
CREATE INDEX quest_settlement_commands_quest_id_idx ON quest_settlement_commands (quest_id);

-- ==================== proof_submission (Quest Application & Fulfillment) ====================
-- Settled via /batch-grill-me interview. Old ProofSubmission (prisma.ts:261).
--
-- owner: polymorphic worker_id OR team_id (same dual-nullable-FK + CHECK shape
-- as quest.cancelled_by_* / quest_edit_history.edited_by_*, except here
-- exactly one must be set, not <=1 — every submission belongs to somebody).
-- GROUP+CANDIDATE submits as one shared row per attempt (team_id set) since
-- rework quota is shared team-wide (see quest_team.rework_limit); everyone
-- else (SOLO+CANDIDATE, and both NO_CANDIDATE paths, which have no team
-- identity at all) is owned by worker_id individually.
-- submitted_by_user_id: which specific Member physically hit submit — always
-- populated (for worker-owned rows this is just worker_id restated, for
-- team-owned rows it's whichever member submitted) — not derivable, kept for
-- audit trail.
--
-- rejectReason/reworkNote (two fields in old schema) merged into one
-- review_note, per interview.
--
-- reworkUsed derives as COUNT(*) WHERE owner = X AND submission_status = 'PROOF_REJECTED',
-- checked against quest_application.rework_limit / quest_team.rework_limit —
-- no attempt_number stored, same derive-don't-store call as elsewhere.
--
-- autoApproveDeadline: NOT stored (unlike old schema's snapshotted column).
-- The SLA is a fixed function of quest.mode, not a versioned policy value:
-- Proof submissions and proof-free completion confirmations must be reviewed
-- within 1 hour of submitted_at — past that, auto-approve. The derived deadline
-- is computed at read/worker time as submitted_at + 1 hour, never snapshotted.
--
-- images: uses the existing file table via a junction table (proof_submission_image),
-- same pattern as profile_portfolio_item_image, instead of old schema's raw
-- imageUrls text array — gets file metadata (bucket/content_type/size) for free.
--
-- Deliberately NOT linked to quest_assignment: team-owned rows can't map 1:1 to
-- a single (per-worker) quest_assignment row, so this only links via quest_id +
-- the polymorphic owner, consistent with the assignment table's own
-- derive-don't-store stance on team/application traceability.
CREATE TABLE proof_submission (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quest_id             UUID NOT NULL REFERENCES quest(id) ON DELETE CASCADE,
  worker_id            UUID REFERENCES auth_user(id),
  team_id              UUID REFERENCES quest_team(id),
  submitted_by_user_id UUID NOT NULL REFERENCES auth_user(id),
  content              VARCHAR(5000) NOT NULL,
  submission_status    VARCHAR(32) NOT NULL DEFAULT 'PROOF_PENDING'
                       CHECK (submission_status IN ('PROOF_PENDING', 'PROOF_APPROVED', 'PROOF_REJECTED', 'PROOF_AUTO_APPROVED')),
  review_note          VARCHAR(1000),
  submitted_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at          TIMESTAMPTZ,
  CHECK (num_nonnulls(worker_id, team_id) = 1)
);
CREATE INDEX proof_submission_quest_id_idx ON proof_submission (quest_id);
CREATE INDEX proof_submission_status_idx ON proof_submission (submission_status);
CREATE INDEX proof_submission_worker_id_idx ON proof_submission (worker_id);
CREATE INDEX proof_submission_team_id_idx ON proof_submission (team_id);

-- Proof-free Quests use one confirmation per obligation. This is not a fake
-- Proof Submission: it records only that the Worker (or Candidate Team) confirmed
-- completion. Its owner shape follows proof_submission.
CREATE TABLE quest_completion_confirmation (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quest_id           UUID NOT NULL REFERENCES quest(id) ON DELETE CASCADE,
  worker_id          UUID REFERENCES auth_user(id),
  team_id            UUID REFERENCES quest_team(id),
  confirmed_by_user_id UUID NOT NULL REFERENCES auth_user(id),
  confirmed_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(worker_id, team_id) = 1),
  UNIQUE (quest_id, worker_id),
  UNIQUE (quest_id, team_id)
);
CREATE INDEX quest_completion_confirmation_quest_idx ON quest_completion_confirmation (quest_id);

-- gallery: a proof submission can have multiple images, ordered — mirrors
-- profile_portfolio_item_image exactly (file table + position)
CREATE TABLE proof_submission_image (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  proof_submission_id UUID NOT NULL REFERENCES proof_submission(id) ON DELETE CASCADE,
  file_id             UUID NOT NULL REFERENCES file(id),
  position            INTEGER NOT NULL DEFAULT 0,
  UNIQUE (proof_submission_id, position)
);
CREATE INDEX proof_submission_image_submission_idx ON proof_submission_image (proof_submission_id);

-- ==================== work_conversation (dedicated Work Conversation — REQUIREMENTS ONLY) ====================
-- BE-170 records the agreed requirements; the Chat module tables and the
-- WorkChatMembershipWriter implementation live in the Work Chat module and
-- its forward migration. No tables are declared here — this block is the
-- contract the Chat EDR must satisfy when it is walked. See also ADR 0005
-- (Quest owns Work Chat membership) and
-- src/modules/quest/quest-work-chat.contract.ts (typed
-- Quest -> Chat port, already on the BE-170 canonical vocabulary).
--  - One dedicated Work Conversation per Quest — never shared between Quests,
--    never more than one per Quest. Participants are the Hirer and Active
--    Workers only; Candidates never join it.
--  - Membership windows: every accepted participant holds an inclusive
--    joinedAt..leftAt window. A departed Worker (ASSIGNMENT_INCOMPLETE /
--    ASSIGNMENT_CANCELLED) retains read access only to history inside their
--    own window and cannot send new content.
--  - Messages are retained: a retained Work Conversation references
--    quest(id) with a restrictive FK (ON DELETE RESTRICT or equivalent), so
--    physical Quest deletion fails while that Chat data exists.
--  - Terminal Quests (QUEST_COMPLETED, QUEST_CANCELLED) make the conversation
--    read-only; QUEST_DISPUTED stays writable while the dispute resolves.
--  - System-message/event and command deduplication: retries reuse commandId
--    (returning the prior result) and eventId (deduplicating system messages).
--  - Quest owns membership atomically: every membership/write-access change
--    goes through WorkChatMembershipWriter inside the Quest database
--    transaction. Chat never fetches members over HTTP and never creates or
--    closes a membership window on its own.
-- Private Candidate Inquiry Conversations (Hirer <-> Prospective Worker) are
-- separate from Work Conversation membership. Their target lifecycle is in
-- docs/quest/work-chat-system-target.md; they are not part of this Quest-owned
-- membership writer block.
