-- ==================== quest_core (Quest Core) ====================
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
-- /grilling) against the schema-wide VARCHAR+CHECK convention used everywhere else (43
-- other tables, including quest's own siblings quest_team.team_status/
-- quest_application.application_status/proof_submission.submission_status). NOT yet a
-- standing pattern — don't convert other tables off
-- the back of this without a separate decision. Trade-off accepted: adding a new status
-- value later needs ALTER TYPE ... ADD VALUE (can't run inside the same transaction as
-- code that uses the new value, pre-PG12 also couldn't run in a transaction at all) versus
-- VARCHAR+CHECK's plain DROP/ADD CONSTRAINT — status is the most volatile column here
-- (quest lifecycle, most likely to grow a value), so this is the sharpest test of whether
-- that cost is worth it.
CREATE TYPE quest_mode AS ENUM ('FIRST_COME_FIRST_SERVED', 'CANDIDATE');
CREATE TYPE quest_participation AS ENUM ('SINGLE', 'GROUP');
CREATE TYPE quest_status AS ENUM ('DRAFT', 'OPEN', 'AWAITING_CONSENT', 'ASSIGNED', 'IN_PROGRESS', 'SUBMITTED',
                                   'APPROVED', 'REWORK', 'COMPLETED', 'CANCELLED', 'DISPUTED', 'HIDDEN', 'UNFILLED');

CREATE TABLE quest (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  giver_id     UUID NOT NULL REFERENCES auth_user(id),
  title        VARCHAR(200) NOT NULL,
  description  VARCHAR(2000),
  condition    VARCHAR(4000) NOT NULL,
  mode         quest_mode NOT NULL,
  participation quest_participation NOT NULL DEFAULT 'SINGLE',
  quest_status quest_status NOT NULL DEFAULT 'DRAFT',
  -- Domain term: Reward. The persisted column keeps the existing wage_baht name for schema compatibility.
  wage_baht    BIGINT NOT NULL CHECK (wage_baht > 0),
  tag_id       UUID REFERENCES tag(id),
  headcount    INTEGER NOT NULL DEFAULT 1 CHECK (headcount > 0),
  start_time   TIMESTAMPTZ NOT NULL,
  due_at       TIMESTAMPTZ,
  proof_required BOOLEAN NOT NULL DEFAULT true,
  cancelled_at TIMESTAMPTZ,
  cancelled_by_user_id  UUID REFERENCES auth_user(id),
  cancelled_by_admin_id UUID REFERENCES auth_admin(id),
  -- HIDDEN is moderation only: an admin unlists a published quest, escrow stays held,
  -- and the quest can go back to OPEN (which clears these). Hirers cannot hide their
  -- own quest — they cancel it. Hence admin-only, unlike cancelled_by_*, which is
  -- polymorphic because a Hirer can cancel too. Reason text belongs to Trust & Safety,
  -- not here.
  hidden_at    TIMESTAMPTZ,
  hidden_by_admin_id UUID REFERENCES auth_admin(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at   TIMESTAMPTZ,
  -- SINGLE quests always have exactly one slot; GROUP sizing is checked at team-submit time (app-layer)
  CHECK (participation = 'GROUP' OR headcount = 1),
  CHECK (due_at IS NULL OR due_at > start_time),
  -- draft quests can be tagless while the Hirer is still filling the form
  CHECK (quest_status = 'DRAFT' OR tag_id IS NOT NULL),
  CHECK (num_nonnulls(cancelled_by_user_id, cancelled_by_admin_id) <= 1),
  CHECK ((cancelled_at IS NULL) = (quest_status <> 'CANCELLED')),
  CHECK ((hidden_at IS NULL) = (quest_status <> 'HIDDEN')),
  CHECK ((hidden_by_admin_id IS NULL) = (hidden_at IS NULL))
);
CREATE INDEX quest_giver_id_idx ON quest (giver_id);
CREATE INDEX quest_status_idx ON quest (quest_status);
CREATE INDEX quest_mode_idx ON quest (mode);
CREATE INDEX quest_tag_id_idx ON quest (tag_id);
CREATE INDEX quest_start_time_idx ON quest (start_time);

-- quest_location: where the quest happens. position is a real visit-order sequence
-- (not just display order) — the Worker must complete location N before N+1 — so it's
-- unique per quest, not just a UI sort hint. No location rows at all is valid and
-- stays valid at publish — online-only quests (design, tutoring over video) are real,
-- and forcing a location on them only produces junk addresses that poison the radius
-- filter. Such a quest simply never matches a lat/lng/radius search, which is correct.
-- Edits after SELECTED go through quest_edit_request like any other quest field —
-- no separate consent mechanism for locations.
--
-- lat/lng are NOT NULL, address is not: the Hirer picks a location by dropping a pin
-- on a map, so coordinates are the thing actually captured, while the address string
-- is reverse-geocoded and often blank or wrong on campus. This way every location row
-- is guaranteed to answer a radius query — no "has a location but can't be found
-- nearby" case, and no WHERE lat IS NOT NULL hidden in every discovery query.
CREATE TABLE quest_location (
  id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quest_id UUID NOT NULL REFERENCES quest(id) ON DELETE CASCADE,
  label    VARCHAR(100),
  address  VARCHAR(500),
  lat      NUMERIC(9, 6) NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lng      NUMERIC(9, 6) NOT NULL CHECK (lng BETWEEN -180 AND 180),
  position INTEGER NOT NULL DEFAULT 1,
  UNIQUE (quest_id, position)
);
CREATE INDEX quest_location_quest_id_idx ON quest_location (quest_id);

-- quest_image: gallery on the quest detail screen (SRS 3.3, FE-27 step 1).
-- Same shape as profile_portfolio_item_image — file reference + ordered position,
-- never a stored storage URL. Deliberately NOT shown on the Quest Board card
-- (ADR 0001 keeps the card image-free for density), so this is detail-screen only.
-- Zero rows is valid; the per-quest cap (10, matching portfolio) is app-layer.
CREATE TABLE quest_image (
  id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quest_id UUID NOT NULL REFERENCES quest(id) ON DELETE CASCADE,
  file_id  UUID NOT NULL REFERENCES file(id),
  position INTEGER NOT NULL DEFAULT 0,
  UNIQUE (quest_id, position)
);
CREATE INDEX quest_image_quest_id_idx ON quest_image (quest_id);

-- ==================== quest_lifecycle (Quest Lifecycle) ====================
-- quest_edit_request: consent gate for edits made after a Worker/team is SELECTED or
-- work is IN_PROGRESS (per Quest Timeline spec — pre-SELECTED edits go straight to
-- quest_edit_history, no consent needed). requested_by is always the Hirer; who must
-- respond is derived at apply-time from the current quest_assignment/quest_team roster,
-- not stored here — avoids denormalizing a roster snapshot into a table whose whole job
-- is being a short-lived approval gate.
CREATE TABLE quest_edit_request (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quest_id     UUID NOT NULL REFERENCES quest(id) ON DELETE CASCADE,
  requested_by_user_id UUID NOT NULL REFERENCES auth_user(id),
  proposed_changes JSONB NOT NULL,
  request_status VARCHAR(32) NOT NULL DEFAULT 'PENDING' CHECK (request_status IN ('PENDING', 'APPROVED', 'REJECTED')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at  TIMESTAMPTZ
);
CREATE INDEX quest_edit_request_quest_idx ON quest_edit_request (quest_id);

-- one row per Worker who must consent (all of them, for GROUP); unanimous required —
-- a single REJECTED fails the whole request immediately (fail-fast), not waited out
CREATE TABLE quest_edit_request_response (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id   UUID NOT NULL REFERENCES quest_edit_request(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL REFERENCES auth_user(id),
  decision     VARCHAR(32) NOT NULL CHECK (decision IN ('APPROVED', 'REJECTED')),
  responded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (request_id, user_id)
);
CREATE INDEX quest_edit_request_response_request_idx ON quest_edit_request_response (request_id);

-- append-only field-diff log. Covers both direct edits (Open/pre-candidate stages,
-- edit_request_id NULL) and edits applied after quest_edit_request approval
-- (edit_request_id set, for traceability). 5-minute post-edit cooldown before a
-- candidate can be selected (Quest Timeline spec) is derived from
-- MAX(edited_at) here, not cached as a separate quest column.
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
-- QuestMode=CANDIDATE. For GROUP + FIRST_COME_FIRST_SERVED (join-until-headcount-reached),
-- no team identity is created — plain QuestAssignment rows against
-- Quest.headcount, same mechanism as SINGLE+FIRST_COME_FIRST_SERVED (deferred to
-- QuestAssignment walk).

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
  team_status   VARCHAR(32) NOT NULL DEFAULT 'FORMING'
                CHECK (team_status IN ('FORMING', 'SUBMITTED', 'SELECTED', 'REJECTED')),
  rework_limit  INTEGER NOT NULL DEFAULT 0 CHECK (rework_limit >= 0),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX quest_team_quest_id_idx ON quest_team (quest_id);
-- enforces "only one team ever works a quest" at DB level; auto-rejecting
-- competing teams on SELECT is still an app-layer transaction, this is the safety net
CREATE UNIQUE INDEX quest_team_one_selected_uidx ON quest_team (quest_id) WHERE team_status = 'SELECTED';

-- leader has a row here too (counts toward headcount). Team size vs
-- Quest.headcount is checked at submit time only, app-layer (not a DB
-- constraint — FORMING teams may transiently exceed/underfill headcount).
-- Cross-team dedup within the same quest (one user, one team per quest) is
-- also app-layer: quest_team_member doesn't carry quest_id, so a DB-level
-- partial unique index would need denormalizing quest_id (+ status) down
-- from quest_team, trading a sync-risk for a constraint that's only ever
-- checked at a single insert point — not worth it here.
CREATE TABLE quest_team_member (
  team_id   UUID NOT NULL REFERENCES quest_team(id) ON DELETE CASCADE,
  user_id   UUID NOT NULL REFERENCES auth_user(id),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, user_id)
);
CREATE INDEX quest_team_member_user_id_idx ON quest_team_member (user_id);

-- ==================== quest_application (SINGLE+CANDIDATE only) (Quest Application & Fulfillment) ====================
-- Settled via /batch-grill-me interview. quest_application exists only for
-- QuestParticipation=SINGLE + QuestMode=CANDIDATE — GROUP+CANDIDATE never
-- creates rows here, it goes through quest_team instead. Old QuestApplication
-- (prisma.ts:233) shape kept close to as-is: no new fields added (YAGNI —
-- nothing in either session's interview called for one, e.g. no cover-note).
--
-- rework_limit: Worker-proposed rework cap, proposed at apply time (before
-- selection) — for SINGLE this is per-individual (contrast quest_team.rework_limit,
-- which is one shared value for the whole team). reworkUsed is NOT stored here —
-- derives from ProofSubmission once that table is walked, same
-- derive-don't-store pattern used elsewhere.
CREATE TABLE quest_application (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quest_id     UUID NOT NULL REFERENCES quest(id) ON DELETE CASCADE,
  hunter_id    UUID NOT NULL REFERENCES auth_user(id),
  application_status VARCHAR(32) NOT NULL DEFAULT 'APPLIED' CHECK (application_status IN ('APPLIED', 'SELECTED', 'REJECTED')),
  rework_limit INTEGER NOT NULL DEFAULT 0 CHECK (rework_limit >= 0),
  applied_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (quest_id, hunter_id)
);
CREATE INDEX quest_application_quest_id_idx ON quest_application (quest_id);
CREATE INDEX quest_application_status_idx ON quest_application (application_status);
-- same "only one ever selected" safety net as quest_team_one_selected_uidx
CREATE UNIQUE INDEX quest_application_one_selected_uidx ON quest_application (quest_id) WHERE application_status = 'SELECTED';

-- ==================== quest_assignment (universal roster, all 4 mode×participation combos) (Quest Application & Fulfillment) ====================
-- Settled via /batch-grill-me interview. The single "who is actually working
-- this quest" table across every combo: FIRST_COME_FIRST_SERVED direct-joiners (SINGLE or
-- GROUP, up to Quest.headcount — headcount-vs-joined-count enforcement is
-- app-layer, same precedent as quest_team size-vs-headcount, not a DB
-- constraint), SINGLE+CANDIDATE's selected applicant, and GROUP+CANDIDATE's
-- selected team's members (one row per member, fanned out at selection time).
--
-- Deliberately does NOT store, vs old QuestAssignment (prisma.ts:246):
--  - team_id / application_id (origin traceability) — always derivable via
--    (quest_id, hunter_id) join back to quest_team_member / quest_application;
--    FIRST_COME_FIRST_SERVED rows have no origin row at all, so a stored FK would be
--    null there regardless. Same derive-don't-store call as reworkUsed.
--  - escrowLocked — derives from wallet_activities (resource_type =
--    'quest_assignment', resource_id = this row's id) instead of a
--    denormalized boolean; wallet_activities already carries the generic
--    resource_type/resource_id hooks for exactly this.
--  - rework_limit — moved to quest_application (SINGLE+CANDIDATE) / quest_team
--    (GROUP+CANDIDATE), since it's proposed by the applying party at
--    commit-to-quest time, which predates and is separate from this table's
--    row (created at selection/join time). NULL/unused for FIRST_COME_FIRST_SERVED.
--  - submittedAt / approvedAt — these are proof-review timestamps, belong on
--    ProofSubmission once that table is walked, not duplicated here.
--
-- assignment_status: old schema had only a boolean `uncomplete` + timestamps, no real
-- status field. Replaced with an explicit status column, consistent with the
-- quest.quest_status / quest_team.team_status convention:
--  - ACTIVE: default, currently working.
--  - COMPLETED: proof approved, quest fulfilled by this Worker.
--  - INCOMPLETE: Worker failed to deliver (no-show / never finished / proof
--    rejected with no rework left) — this platform has no voluntary
--    post-selection leave (confirmed: team members can't leave after
--    SELECTED), so this is always a failure state attributable to the
--    Worker, the future home for the deferred Worker "red flag" behavior.
--  - CANCELLED: assignment ended because the quest itself was cancelled —
--    explicitly NOT the Worker's fault, kept distinct from INCOMPLETE so
--    penalty/red-flag logic can tell the two apart.
CREATE TABLE quest_assignment (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quest_id   UUID NOT NULL REFERENCES quest(id) ON DELETE CASCADE,
  hunter_id  UUID NOT NULL REFERENCES auth_user(id),
  assignment_status VARCHAR(32) NOT NULL DEFAULT 'ACTIVE'
             CHECK (assignment_status IN ('ACTIVE', 'COMPLETED', 'INCOMPLETE', 'CANCELLED')),
  started_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (quest_id, hunter_id)
);
CREATE INDEX quest_assignment_quest_id_idx ON quest_assignment (quest_id);
CREATE INDEX quest_assignment_hunter_id_idx ON quest_assignment (hunter_id);
CREATE INDEX quest_assignment_status_idx ON quest_assignment (assignment_status);

-- ==================== proof_submission (Quest Application & Fulfillment) ====================
-- Settled via /batch-grill-me interview. Old ProofSubmission (prisma.ts:261).
--
-- owner: polymorphic Worker reference (hunter_id) OR team_id (same dual-nullable-FK + CHECK shape
-- as quest.cancelled_by_* / quest_edit_history.edited_by_*, except here
-- exactly one must be set, not <=1 — every submission belongs to somebody).
-- GROUP+CANDIDATE submits as one shared row per attempt (team_id set) since
-- rework quota is shared team-wide (see quest_team.rework_limit); everyone
-- else (SINGLE+CANDIDATE, and both FIRST_COME_FIRST_SERVED paths, which have no team
-- identity at all) is owned by an individual Worker.
-- submitted_by_user_id: which specific member physically hit submit — always
-- populated (for Worker-owned rows this is just hunter_id restated, for
-- team-owned rows it's whichever member submitted) — not derivable, kept for
-- audit trail.
--
-- rejectReason/reworkNote (two fields in old schema) merged into one
-- review_note, per interview.
--
-- reworkUsed derives as COUNT(*) WHERE owner = X AND submission_status = 'REJECTED',
-- checked against quest_application.rework_limit / quest_team.rework_limit —
-- no attempt_number stored, same derive-don't-store call as elsewhere.
--
-- autoApproveDeadline: NOT stored (unlike old schema's snapshotted column).
-- The SLA is a fixed function of quest.mode, not a versioned policy value:
-- FIRST_COME_FIRST_SERVED quests must be reviewed within 1 hour of submitted_at, CANDIDATE
-- quests within 2 hours — past that, auto-approve. Derived at read/worker time
-- as submitted_at + (1h or 2h depending on joined quest.mode), never snapshotted.
--
-- images: uses the existing file table via a junction table (proof_submission_image),
-- same pattern as profile_portfolio_item_image, instead of old schema's raw
-- imageUrls text array — gets file metadata (bucket/content_type/size) for free.
--
-- Deliberately NOT linked to quest_assignment: team-owned rows can't map 1:1 to
-- a single (per-Worker) quest_assignment row, so this only links via quest_id +
-- the polymorphic owner, consistent with the assignment table's own
-- derive-don't-store stance on team/application traceability.
CREATE TABLE proof_submission (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quest_id             UUID NOT NULL REFERENCES quest(id) ON DELETE CASCADE,
  hunter_id            UUID REFERENCES auth_user(id),
  team_id              UUID REFERENCES quest_team(id),
  submitted_by_user_id UUID NOT NULL REFERENCES auth_user(id),
  content              VARCHAR(5000) NOT NULL,
  submission_status    VARCHAR(32) NOT NULL DEFAULT 'PENDING'
                       CHECK (submission_status IN ('PENDING', 'APPROVED', 'REJECTED', 'AUTO_APPROVED')),
  review_note          VARCHAR(1000),
  submitted_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at          TIMESTAMPTZ,
  CHECK (num_nonnulls(hunter_id, team_id) = 1)
);
CREATE INDEX proof_submission_quest_id_idx ON proof_submission (quest_id);
CREATE INDEX proof_submission_status_idx ON proof_submission (submission_status);
CREATE INDEX proof_submission_hunter_id_idx ON proof_submission (hunter_id);
CREATE INDEX proof_submission_team_id_idx ON proof_submission (team_id);

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
