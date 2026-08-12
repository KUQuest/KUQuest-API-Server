-- KUQuest schema — REDESIGN IN PROGRESS
-- Settled via /grilling interview: user, admin, session, account, verification, wallet/ledger, payments, profile,
-- quest (core), quest_location, quest_edit_request/_response, quest_edit_history, quest_team/quest_team_member,
-- quest_application, quest_assignment, proof_submission/proof_submission_image.
-- ChatMessage/Review/Report/Dispute/AdminAction/Notification onward still on old design, not yet walked.
-- Tables prefixed by module: auth_, wallet_, payment_, profile_.
--
-- Sync note (2026-08-06): auth/academic/file/profile sections below re-synced against
-- KUQuest-API-Server's actual Drizzle migrations (drizzle/0000..0008), which is ahead of
-- this file on those 4 modules — real implementation work happened (BE-32, BE-94, BE-95,
-- BE-96, admin better-auth wiring) without this file being updated alongside it. wallet_*/
-- payment_*/quest*/tag are still design-only below — no migration exists for them yet, so
-- they're unchanged from the interview-derived design.
--
-- Design decision (2026-08-07, via /grilling): auth_user/auth_admin/auth_session/
-- auth_account/auth_verification's id columns changed TEXT -> UUID (DEFAULT
-- gen_random_uuid()), and every FK referencing auth_user(id)/auth_admin(id) across the
-- whole schema (~40 columns: wallet_*, payment_*, profile_*, quest* actor/owner columns)
-- follows suit. Design-doc only — NOT applied to KUQuest-API-Server, which still runs
-- better-auth's default TEXT ids (drizzle/0000..0008) and needs its own migration +
-- auth.config.ts generateId:false change before this matches reality.

-- VARCHAR sizing outside Wallet & Payments:
--   10   fixed Student ID and Thai telephone values
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

-- This is the ordered psql entry point for the modular EDR SQL files.
-- The \ir commands are psql commands, not portable SQL.
\ir 00-extensions.sql
\ir 01-auth.sql
\ir 02-wallet.sql
\ir 03-payments.sql
\ir 04-profile.sql
\ir 05-quest.sql
