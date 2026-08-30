# PR 337 Fix Plan

## Context

PR 337 (`fix/staging-326-331`) fixes staging defects for Quest, Payout, and
Work Chat. The current review accepts the fixes for #326, #327, #328, and
#331. It requests more work for #329 (Work Chat) and #330 (Payout).

The target domain terms are `Quest`, `Member`, `Hirer`, `Worker`, `Accepted
Participant`, `Assignment`, `Work Conversation`, `Candidate Inquiry
Conversation`, `System Message`, `Payout`, and `Payout Destination`.

## Goal

Make the remaining PR 337 behavior explicit, testable, and safe:

1. Send Thai Payouts with a provider channel mapping and the complete Xendit
   V2 request body.
2. Keep Work Conversation history authoritative in REST and add committed
   process-local delivery for current Accepted Participants.
3. Return System Messages as messages from the KU bot with safe Event data.
4. Keep Work Conversation and Candidate Inquiry Conversation separate.
5. Give Members a way to discard temporary attachments and return a wait time
   when a rate limit blocks a request.
6. Preserve the existing Quest-owned membership and transaction boundaries.

## Implementation slices

### 1. Payout

- Map every supported internal Thai bank code to its explicit Xendit channel
  code. Use `TH_SCB` for `SCB` and an explicit `PROMPTPAY` mapping.
- Include `account_holder_name` beside `account_number` in
  `channel_properties`.
- Validate provider responses against the mapped channel code.
- Keep Student diagnostics safe and keep useful sanitized diagnostics for an
  authorized Admin.
- Add exact request-body tests for SCB, another Thai bank, and PromptPay.

### 2. Work Conversation boundary and System Messages

- Add the persisted conversation type:
  `CONVERSATION_WORK` or `CONVERSATION_CANDIDATE_INQUIRY`.
- Existing Quest chat rows are backfilled as `CONVERSATION_WORK`.
- Work Conversation APIs accept only `CONVERSATION_WORK` rows. Candidate
  Inquiry Conversation access remains separate and does not copy history.
- Project a System Message as the `KU bot`, with `eventId`, `systemType`, and
  safe `systemPayload`. Do not include private Proof or full Profile data.
- Include the affected Worker's display name where the Event concerns a
  Worker. Keep action data permission-safe.

### 3. Attachments and rate limits

- Add Member-authorized discard for an attachment that is still in the
  composer. Tombstone the database rows and clean the object from private
  storage after the database commit.
- Keep failed-upload compensation. Add a retryable cleanup marker for object
  deletion failures.
- Keep the existing 15-minute signed link and visibility checks.
- Return `Retry-After` on a `429 RATE_LIMITED` response. Calculate it from the
  oldest records needed to make room. A blocked send keeps its prepared
  attachments unchanged.

### 4. Committed delivery

- Add a small process-local delivery interface and an Elysia WebSocket
  subscription for committed Work Conversation Message Events. The service
  publishes only after the Message transaction commits.
- Resolve current Work Conversation Members after commit and exclude the
  sender, departed Members, and unauthorized Members.
- Make delivery idempotent per connection and Event. REST remains the source
  of truth and remains the recovery path. No WebSocket write protocol is
  added.

## Verification

- Add or update focused integration tests before implementation where possible.
- Run typecheck, lint, database schema checks, focused Payout and Work Chat
  tests, the full test suite, and `git diff --check`.
- Rename DB-backed application-service tests to the `.integration.test.ts`
  convention.
- Use timestamp-named forward migrations in the migration check. The existing
  numbered journal has a historical index/name collision at `0044`.
- Do not change `.github/workflows/`; application changes belong in a PR with
  base `develop`.

## Known gaps and evidence requirements

- The repository does not contain the referenced ADR 0025. This is a
  documentation gap and is not silently recreated here.
- The target Work Chat document defines a 15-minute signed-link lifetime but
  does not define an expiry duration for unsent attachments. This change
  implements explicit discard and cleanup for rows that have an expiry, but a
  product/ADR decision is still required before assigning a default upload
  expiry.
- The repository has no existing Android FCM adapter. Real Android Push,
  foreground Popup behavior, and Push retry/disabled-recipient behavior
  require the client/Push contract and staging evidence before PR 337 can be
  marked fully ready. Quest-originated System Messages also need a post-commit
  hook or outbox if they must be delivered over the same process-local channel;
  they remain available through authoritative REST history.
- Payout verification must include Xendit Test Mode or staging evidence with
  the configured development key. Mock tests alone do not prove provider
  acceptance.
