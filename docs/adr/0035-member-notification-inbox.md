# ADR 0035: Keep a Member notification inbox for penalty Events

## Status

Accepted

## Context

A Member Penalty Notification is a Push. A Member can disable a Push Device, or
an Android alert can be missed. A banned Member cannot sign in, so the Member
cannot read a penalty Event through the app during the ban. The product needs a
server-side record that the client can read after a Push, without a new
localization duty on the Server.

Three questions were open: what the inbox holds, how long the Server keeps an
item, and whether the Member receives `PENALTY_BAN_APPLIED`.

## Decision

- **Scope**: The inbox holds Events only. It starts with the five Member
  Penalty Notification types. It does not hold Work Conversation messages or
  System Messages. Chat history stays in the Work Conversation, and a Push for a
  Message does not create an inbox item.
- **Retention**: The Server keeps an inbox item for at least 90 days after
  `createdAt`. A later retention worker can remove older items.
- **Ban delivery**: `PENALTY_BAN_APPLIED` is delivered as a Push. The Member
  learns the result and `expiresAt` (omitted for a permanent ban) even though
  sign-in is denied. The inbox stays unreachable until the ban ends.
- **Critical Events**: All five types are critical. A Member cannot mute them
  per Quest. The types have no `questId`.
- **No localized text**: The Server sends `type`, `result`, and `expiresAt`. The
  client builds the text.
- **Privacy**: No payload or inbox item names the reporter or includes Message
  text, proof, the Admin note, or the filed Conduct Report reason.
- **Idempotency**: `transitionId` equals `eventKey`. `notificationId` is stable
  for one transition and one recipient. `POST /api/v1/notifications/read` is
  idempotent.
- **Active Red Flag**: `redFlagged` on Member data and `hirerRedFlagged` on Quest
  data mean "a Red Flag is active now". The Server computes them from
  `redFlagExpiresAt` with `isRedFlagActive`. A Red Flag that has passed
  `expiresAt` reads as `false` before the expiry Event is sent.

## Consequences

- The Server needs one notification table and three routes
  (`GET /api/v1/notifications`, `GET /api/v1/notifications/unread-count`,
  `POST /api/v1/notifications/read`).
- The Push module reuses the delivery state and retry rules of ADR 0017 and
  ADR 0018. The inbox item is created in the same transaction as the penalty
  transition.
- The upheld Conduct Report Push no longer names the filed reason. The client
  shows result and end time only.
- A permanent ban has no `PENALTY_BAN_ENDED` Event.
- Adding Work Conversation messages to the inbox later needs a new ADR.
