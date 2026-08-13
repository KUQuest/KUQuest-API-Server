-- KUQuest schema design reference.
-- Runtime tables are defined in src/database/schema/*.ts and applied by Drizzle migrations.
-- Keep this EDR readable as the domain/design companion; do not apply it as a runtime migration.
-- Settled via /grilling interview: user, admin, session, account, verification, wallet/ledger, payments, profile,
-- quest (core), quest_location, quest_edit_request/_response, quest_edit_history, quest_team/quest_team_member,
-- quest_application, quest_assignment, proof_submission/proof_submission_image.
-- ChatMessage/Review/Report/Dispute/AdminAction/Notification onward still on old design, not yet walked.
-- Tables prefixed by module: auth_, wallet_, payment_, profile_.
--
-- Sync note (2026-08-06): auth/academic/file/profile sections below were originally re-synced
-- against the runtime Drizzle migrations. The runtime schema is now represented in
-- src/database/schema/*.ts and migration 0012; this file remains the interview-derived design
-- companion rather than a second migration source. wallet_*/payment_*/quest*/tag are included here
-- for domain vocabulary and rationale.
--
-- Design decision (2026-08-07, via /grilling): auth_user/auth_admin/auth_session/
-- auth_account/auth_verification's id columns are UUIDs (DEFAULT gen_random_uuid()), and every FK
-- referencing auth_user(id)/auth_admin(id) across the whole schema follows suit. Runtime migration
-- 0012 converts existing Better Auth text IDs through a generated UUID mapping, and both Better Auth
-- instances use advanced.database.generateId = 'uuid' for new records.

-- VARCHAR sizing outside Wallet & Payments:
--   10   fixed Student ID values
--   12   formatted Thai telephone values
--   32   status/decision values that remain VARCHAR+CHECK vocabularies
--   50   short controlled-ish labels (employment type, terms version)
--   63   S3 bucket names (AWS limit)
--   100  names, handles, tags, and short labels (matches API name validation)
--   120  portfolio/work titles (matches the portfolio API)
--   200  certificate names/issuers and quest/team titles
--   255  MIME/provider/hash-like values and password hashes
--   500  reverse-geocoded addresses
--   512  HTTP User-Agent values
--   1,000 user-authored bios, descriptions, and review notes
--   1,024 S3 object keys
--   2,048 scopes, verification values, and legacy image URLs
--   5,000 quest proof content
--   8,192 opaque OAuth tokens
-- These are database guardrails; request schemas must enforce the same limits
-- before the corresponding runtime tables are migrated.

-- This remains an ordered psql entry point for inspecting the design reference in isolation.
-- Runtime deployments use Drizzle migrations instead. The \ir commands are psql commands, not portable SQL.
\ir 00-extensions.sql
\ir 01-auth.sql
\ir 02-wallet.sql
\ir 03-payments.sql
\ir 04-profile.sql
\ir 05-quest.sql
