# ADR 0037: Extend the Member notification inbox to Quest and Dispute Events

## Status

Accepted. It extends [ADR 0035](0035-member-notification-inbox.md).

## Context

ADR 0035 made the inbox hold the five Member Penalty Notification types. A
Member who disables a Push Device, or who misses an alert, cannot see a Quest
Event or a Dispute Case Event later. The mobile app needs one list for all
Events, a badge per category, a way to hide a row, and a signal to refetch.

Three questions were open: does the inbox hold all eight Quest Push types, how
does an expired `*_PENDING` row behave, and does dismiss ship now. The product
answers are in the Decision.

## Decision

- **Types and categories**: The inbox holds 15 types in 3 categories.
  - `PENALTY` (5, no change): `PENALTY_RED_FLAG_APPLIED`,
    `PENALTY_RED_FLAG_EXPIRED`, `PENALTY_BAN_APPLIED`, `PENALTY_BAN_ENDED`,
    `CONDUCT_REPORT_UPHELD`.
  - `QUEST` (8): `UNDERFILLED_DECISION_PENDING`,
    `UNDERFILLED_CONSENT_PENDING`, `UNDERFILLED_COMPLETED`,
    `UNDERFILLED_CANCELLED`, `QUEST_ASSIGNED`, `PROOF_NOT_APPROVED`,
    `QUEST_COMPLETED_DISPUTE_WINDOW_OPEN`, `QUEST_FAILED`.
  - `DISPUTE` (2): `DISPUTE_CASE_FILED_AGAINST_YOU`, `DISPUTE_CASE_DECIDED`.
    These two have inbox and realtime only. They have no Push.
- **Same transaction**: The Server writes a Quest Event row in the same
  transaction as its Push. A Push without a row cannot exist.
- **Row envelope (additive)**: An item keeps its ADR 0035 fields and adds
  `category`, `questTitle` (a snapshot at Event time), `actorRole` (`HIRER` or
  `WORKER`), `cancellationReason` (`HIRER_CANCELLED`, `HIRER_NO_DECISION`,
  `WORKER_DECLINED`, `CONSENT_TIMEOUT`), `failureReason`
  (`PROOF_NOT_APPROVED`, `COMPLETION_NOT_APPROVED`, `DUE_AT_MISSED`),
  `assignmentId`, `disputeCaseId`, `disputeStatus`, and `viewerWon`. An item
  never holds the reporter, the filed reason, proof, Message text, an amount, or
  data of the other party. The Server sends codes and never localized text.
- **Routes**:
  - `GET /api/v1/notifications` accepts a repeatable `category` query.
  - `GET /api/v1/notifications/unread-count` returns `{ count, byCategory }`.
  - `POST /api/v1/notifications/read` accepts `category` only together with
    `all`.
  - New `POST /api/v1/notifications/dismiss` takes `{ ids }` (1 to 100). It is
    idempotent and also marks the row read. A penalty row cannot be dismissed:
    the Server returns `400 NOTIFICATION_NOT_DISMISSABLE`.
- **Dismiss is hide, not delete**: A dismissed row stays in storage. Penalty
  rows are never dismissed, so they stay as the audit trail.
- **Retention**: The Server keeps a row for at least 90 days after `createdAt`
  (the ADR 0035 rule stays). After that period the retention worker hard-deletes
  the row.
- **Expired `*_PENDING` row**: The row stays unread. The app reads `expiresAt`
  and shows the row as expired. The Server does not mark it read.
- **Ban access**: The inbox routes and the events socket skip the ban guard. A
  banned Member with an existing session reads the own inbox (`200`). Every
  other route keeps `403 MEMBER_BANNED`. New sign-in stays denied.
  - Limitation: a ban does not revoke an existing session today. A Member who is
    signed out (for example a Member with a permanent ban) cannot sign in and so
    cannot read the row. The public ban-status route is not built.
  - Alternative not chosen: a public ban-status route that a signed-out Member
    can call. It needs a new unauthenticated surface, an identity proof for a
    Member who cannot sign in, and a privacy review. The skip of the ban guard
    for the inbox needs no new surface.
- **Realtime**: `GET /api/v1/notifications/events` is a WebSocket. It uses the
  same Origin and Cookie rules as `/api/v1/wallet/events`. The only frame is
  `{ "type": "NOTIFICATIONS_CHANGED" }` with no payload. The client refetches the
  count and the first page. The Server publishes the frame after commit when it
  creates a row.
- **Push data**: Every inbox-type Push carries `notificationId`, `category`, and
  `route` (for example `/notifications` or `/quest/{questId}`).
  `CONDUCT_REPORT_UPHELD` always has `notificationId`. The existing keys and
  `transitionId` stay. The deep link scheme is `kuquestmobile://`. App builds
  also use `kuquestmobile-staging` and `kuquestmobile-uat`. The old `kuquest://`
  scheme is retired.
- **Out of scope**: Payout and Top-up status, and Work Chat Messages. Chat keeps
  its own unread state.

## Consequences

- The notification table gains the envelope columns and a dismissed marker. The
  migration is additive.
- ADR 0035 stays valid for the five penalty types. Its statements that the
  inbox holds penalty types only, and that a banned Member cannot reach the
  inbox, are replaced by this ADR.
- A client must handle an unknown `type` or `category` as a generic row.
- Adding Payout, Top-up, or Work Chat Messages later needs a new ADR.
