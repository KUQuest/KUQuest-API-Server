# Work Chat REST and WebSocket contract

This is the canonical contract for the Work Chat MVP. It defines the private
Conversation associated with a Quest, the REST read and write surfaces, and the
single-instance WebSocket delivery protocol.

The contract uses the repository terms in CONTEXT.md: Member, Hirer, Worker,
Accepted Participant, Work Conversation, Chat Membership, Message, Attachment,
Read Cursor, and System Message.

## Scope and ownership

One Work Conversation exists for one Quest. The first accepted Worker creates
the Conversation and the Hirer joins it in the same Quest transaction. Later
accepted Workers join the same Conversation.

Quest owns the Hirer, Worker, Assignment, Quest Status, and accepted
participation. Quest calls the typed Work Chat membership writer from the same
database transaction that changes the Quest. Work Chat does not fetch
membership over HTTP and does not keep an independently editable roster. See
ADR 0005, Quest owns Work Chat membership.

Work Chat owns Conversation, Message, Attachment, and Read Cursor persistence.
Trust & Safety owns Report Case, Reporter Entry, and Moderation Decision.
Admin Infra owns the Admin Action audit record required for moderation.

The current Quest domain contract has no transition that reopens a Terminal
Quest. In this document, rejoin means that a departed Worker is accepted again
while the Quest is not terminal. Rejoin creates a new Chat Membership window;
it does not reactivate a Terminal Quest or create a second Conversation.

## Domain model

### Conversation

A Conversation has one immutable Quest reference. It contains:

- the Hirer and current Workers as current Chat Memberships;
- historical Chat Membership windows for departed Workers;
- ordered Member-authored Messages and immutable System Messages;
- archived and read-only state derived from Quest lifecycle.

The Conversation is created when the first Worker is accepted. It is not
created for a Candidate who has not been accepted. A Terminal Quest makes its
Conversation read-only. Retained Conversation data prevents physical Quest
deletion until the retention policy permits cleanup.

### Message

A Message is immutable after PostgreSQL commits it. A Member-authored Message has text,
Attachments, or both. A System Message has a server-defined event type and
cannot be created through the Member Message endpoint.

The server assigns the Message identifier, Conversation sequence, and creation
time. Sequence is strictly ordered inside one Conversation and is the stable
ordering key for history and gap recovery. A Message can contain at most five
Attachments. Text is at most 4,000 characters after the API validates the
request.

### Attachment

An Attachment is uploaded before Message creation. The file enters private
quarantine, passes actual-signature and size checks, and is scanned with
ClamAV. Only a clean Attachment receives an attachment identifier that a
Message may consume.

An Attachment belongs to one intended Conversation and may be consumed once by
its uploader. A signed viewing link is created only after the server verifies
that the requester can read the containing Message. Storage keys, quarantine
locations, and signed URLs are never part of logs or Message persistence.

### Temporal access

| Situation | Read access | Send access | WebSocket delivery |
| --- | --- | --- | --- |
| Current Accepted Participant | Full Conversation history | Yes, until the Conversation is read-only | Current committed events |
| Departed Worker | Messages created no later than leftAt | No | No later events |
| Reaccepted Worker | Full Conversation history through the new window | Yes, while current | Current committed events |
| Candidate | No Conversation access | No | No subscription |
| Terminal Quest participant | Full retained history | No | System and state events only |

A departure closes the Worker's current Chat Membership at the supplied
leftAt. A reacceptance creates a new window and permits full history again.
Access is evaluated in the database query for every read, Message, Attachment,
and Report operation.

Membership and lifecycle transitions create immutable System Messages:
participant accepted, participant departed, and the Conversation becoming
read-only because the Quest became COMPLETED or CANCELLED. A rejoin is recorded
as a new participant-accepted System Message. A Terminal Quest cannot reopen in
the current MVP contract.

## Authorization and privacy

Member routes require a valid Better Auth Member Session. Admin routes require
the separate Admin Session. An Admin Session is never treated as a Member
Session, and an Admin cannot join or send in a Work Conversation through the
moderation API.

The service query must include the caller's Chat Membership and its temporal
visibility. Reading a row first and checking membership in application code is
not sufficient.

Missing and unauthorized resources are indistinguishable:

- an inaccessible or missing Conversation returns 404 CONVERSATION_NOT_FOUND;
- an inaccessible or missing Message returns 404 MESSAGE_NOT_FOUND;
- an inaccessible or missing Attachment returns 404 ATTACHMENT_NOT_FOUND;
- an inaccessible or missing Report returns 404 REPORT_NOT_FOUND;
- an inaccessible or missing Report Case returns 404 REPORT_CASE_NOT_FOUND.

These rules apply to REST identifiers, cursors that name a resource, and
Attachment link requests. Error messages do not identify whether the resource
exists.

Work Chat is server-readable. It does not use end-to-end encryption because
Admin moderation must inspect the reported Message and its bounded evidence.
TLS, database authorization, private object storage, short-lived signed links,
and least-privilege Admin evidence access protect the content instead.

Logs and metrics may contain safe resource identifiers, counts, durations,
statuses, correlation identifiers, and error categories. They must not contain
Message text, Report detail, file bytes, signed URLs, Session tokens, or
moderation evidence.

## Common HTTP contract

All successful and failed Chat responses use the repository envelope:

~~~json
{
  "success": true,
  "data": {}
}
~~~

~~~json
{
  "success": false,
  "error": {
    "code": "CONVERSATION_NOT_FOUND",
    "message": "Conversation not found"
  }
}
~~~

The API uses status 200 for successful operations, including an idempotent
replay. Every route documents its success schema and error status in OpenAPI.
Dates are ISO 8601 date-time strings. Conversation, Message, Attachment,
Report, event, and Quest identifiers are opaque server values. Clients must
not decode or construct them.

Member routes use authGuard and the Member security scheme. Admin routes use
the Admin authentication guard and the Admin security scheme. Request bodies,
parameters, and queries reject unknown fields and invalid values. As in the
existing Elysia contract, request validation runs before the authentication
hook; a malformed request may therefore return 400 VALIDATION before an
anonymous request reaches 401 UNAUTHORIZED.

The current shared response helper lists 400, 401, 404, 409, 413, 415, and 502.
The Chat rate-limit routes must add 429 to their response metadata while
keeping the same response envelope.

## Response shapes

### Conversation summary

~~~json
{
  "id": "conversation-id",
  "quest": {
    "id": "quest-id",
    "title": "Quest title",
    "status": "OPEN"
  },
  "latestMessage": {
    "id": "message-id",
    "kind": "USER",
    "preview": "Latest visible content",
    "createdAt": "2026-08-27T10:00:00.000Z"
  },
  "lastActivityAt": "2026-08-27T10:00:00.000Z",
  "archived": false,
  "readOnly": false,
  "unreadCount": 2
}
~~~

latestMessage, lastActivityAt, and unreadCount are calculated from content
visible to the caller. A departed Worker must not receive a later Message
preview or activity time.

### Message

~~~json
{
  "id": "message-id",
  "conversationId": "conversation-id",
  "sequence": 42,
  "kind": "USER",
  "sender": {
    "id": "member-id",
    "displayName": "Member name"
  },
  "text": "Message text",
  "attachments": [
    {
      "id": "attachment-id",
      "fileName": "brief.pdf",
      "mediaType": "application/pdf",
      "sizeBytes": 12000,
      "createdAt": "2026-08-27T10:00:00.000Z"
    }
  ],
  "systemType": null,
  "createdAt": "2026-08-27T10:00:00.000Z"
}
~~~

kind is USER or SYSTEM. A System Message has sender set to null, text
generated by the server, and a non-null systemType. A deleted Member is
rendered as Former member and does not expose the deleted identity. Hidden
content is returned as a fixed placeholder with no hidden text or Attachment
link.

## REST API

### List Conversations

GET /api/v1/chat/conversations

Requires a Member Session.

Query:

- limit: optional integer from 1 to 20; default 20;
- cursor: optional opaque cursor from the previous response.

The server orders items by last visible activity descending, then by an
immutable Conversation tie-breaker descending. The response is:

~~~json
{
  "success": true,
  "data": {
    "items": [],
    "nextCursor": null
  }
}
~~~

An absent or empty collection is successful. Invalid limit or cursor returns
400 INVALID_LIMIT or INVALID_CURSOR. A missing or unauthorized Member Session
returns 401 UNAUTHORIZED.

### List Message history

GET /api/v1/chat/conversations/:conversationId/messages

Requires a Member Session with current or historical visibility for the
Conversation.

Query:

- limit: optional integer from 1 to 50; default 50;
- before: optional opaque cursor for the next older page;
- after: optional opaque cursor for Messages after the client's last known
  Message, used for reconnect gap recovery.

before and after are mutually exclusive. Without a cursor, the server returns
the newest page. Items inside a page are ordered by Conversation sequence
ascending. nextCursor points to the next page in the selected direction, and
hasMore states whether that page exists.

~~~json
{
  "success": true,
  "data": {
    "items": [],
    "nextCursor": null,
    "hasMore": false
  }
}
~~~

Malformed, cross-Conversation, or unusable cursors return 400 INVALID_CURSOR.
Missing or unauthorized Conversations return 404 CONVERSATION_NOT_FOUND. The
query never returns Messages outside the caller's temporal visibility window.

### Send a Message

POST /api/v1/chat/conversations/:conversationId/messages

Requires a current Accepted Participant and a non-read-only Conversation.

JSON body:

~~~json
{
  "clientMessageId": "client-generated-id",
  "text": "Optional text",
  "attachmentIds": ["attachment-id"]
}
~~~

Validation:

- clientMessageId is required, non-empty, and at most 128 characters;
- text is optional, but when present it is non-empty after trimming and at
  most 4,000 characters;
- attachmentIds is optional, contains unique identifiers, and has at most five
  items;
- at least text or one Attachment is required;
- every Attachment must be clean, intended for this Conversation, unused, and
  uploaded by this Member;
- unknown fields are rejected.

The response is 200 with data.message containing the committed Message. The
server commits PostgreSQL before returning the response or publishing a
WebSocket event.

The same Member, Conversation, and clientMessageId with the same content
returns the original Message. Reusing clientMessageId with different content
returns 409 CLIENT_MESSAGE_ID_REUSED. A departed or non-member caller receives
404 CONVERSATION_NOT_FOUND. A Terminal Quest Conversation returns 409
CONVERSATION_READ_ONLY. An unavailable Attachment returns
404 ATTACHMENT_NOT_FOUND. Invalid content returns 400 MESSAGE_CONTENT_REQUIRED
or 400 MESSAGE_TOO_LONG.

### Advance a Read Cursor

POST /api/v1/chat/conversations/:conversationId/read

Requires current or historical visibility for the Conversation.

JSON body:

~~~json
{
  "messageId": "visible-message-id"
}
~~~

The Message must be visible to this Member in this Conversation. The Read
Cursor only moves forward by Conversation sequence. A request at the current
or an older position is a successful no-op.

The response is:

~~~json
{
  "success": true,
  "data": {
    "conversationId": "conversation-id",
    "messageId": "visible-message-id"
  }
}
~~~

Missing, other-Conversation, or invisible Messages return 404
MESSAGE_NOT_FOUND. The Read Cursor is never exposed as a read receipt to other
Members.

### Upload an Attachment

POST /api/v1/chat/conversations/:conversationId/attachments

Requires a current Accepted Participant and a non-read-only Conversation.

The request is multipart/form-data with exactly one file field named file.
Allowed actual file types are JPEG, PNG, WebP, and PDF. The maximum size is
10 MB. Client MIME type and filename do not override actual signature checks.

Upload sequence:

1. Stream the object to private quarantine.
2. Validate its actual signature and size.
3. Scan it with ClamAV.
4. Promote only a clean object to the private ready location.
5. Persist the clean Attachment reference and return its identifier.

On any failed, unavailable, or malware-positive scan, the object is removed and
no reusable Attachment identifier is returned. The response is:

~~~json
{
  "success": true,
  "data": {
    "attachment": {
      "id": "attachment-id",
      "fileName": "brief.pdf",
      "mediaType": "application/pdf",
      "sizeBytes": 12000,
      "createdAt": "2026-08-27T10:00:00.000Z",
      "expiresAt": "2026-08-28T10:00:00.000Z"
    }
  }
}
~~~

An unconsumed Attachment expires after 24 hours from PostgreSQL and object
storage. Errors are 404 CONVERSATION_NOT_FOUND, 409 CONVERSATION_READ_ONLY,
413 ATTACHMENT_TOO_LARGE, 415 UNSUPPORTED_ATTACHMENT_TYPE,
429 RATE_LIMITED, 502 ATTACHMENT_SCAN_UNAVAILABLE, or 502
ATTACHMENT_UPLOAD_FAILED.

### Get an Attachment link

GET /api/v1/chat/attachments/:attachmentId/link

Requires a Member Session. The server checks the Attachment's containing
Message and the caller's temporal visibility before creating a signed link.
The response is:

~~~json
{
  "success": true,
  "data": {
    "attachment": {
      "id": "attachment-id",
      "url": "short-lived-signed-url",
      "expiresAt": "2026-08-27T10:05:00.000Z"
    }
  }
}
~~~

The URL is short-lived and never persisted. The server controls the lifetime
and clients use expiresAt rather than assuming a fixed lifetime.
Missing, hidden, rejected, quarantined, expired, or unauthorized Attachments
return 404 ATTACHMENT_NOT_FOUND.

### Submit a Message Report

POST /api/v1/chat/reports

Requires a Member Session and visibility of the reported Message.

JSON body:

~~~json
{
  "messageId": "message-id",
  "reason": "HARASSMENT",
  "detail": "Optional explanation"
}
~~~

reason is one of HARASSMENT, SPAM, INAPPROPRIATE_CONTENT, DANGER_OR_THREAT,
or OTHER. detail is optional, non-empty when present, and at most 1,000
characters. A Member may create one Reporter Entry for one Message. Repeating
the same request returns the existing entry and does not create another row.

The response is 200 with:

~~~json
{
  "success": true,
  "data": {
    "report": {
      "id": "report-id",
      "messageId": "message-id",
      "status": "PENDING",
      "createdAt": "2026-08-27T10:00:00.000Z",
      "updatedAt": "2026-08-27T10:00:00.000Z"
    }
  }
}
~~~

An invisible or missing Message returns 404 MESSAGE_NOT_FOUND. Invalid input
returns 400 VALIDATION. The Report response never contains another reporter's
identity or the moderation evidence.

### List own Message Reports

GET /api/v1/chat/reports

Requires a Member Session.

Query limit defaults to 20 and is limited to 50. cursor is opaque and follows
the repository cursor rules. The response contains only the current Member's
Reporter Entries:

~~~json
{
  "success": true,
  "data": {
    "items": [],
    "nextCursor": null
  }
}
~~~

Invalid paging returns 400 INVALID_LIMIT or INVALID_CURSOR. No other Member's
Report is returned.

### Get one own Message Report

GET /api/v1/chat/reports/:reportId

Requires a Member Session. A missing or another Member's Report returns 404
REPORT_NOT_FOUND. The response is the same report shape used by submission.

### List Report Cases as an Admin

GET /api/v1/admin/chat-reports

Requires an enabled Admin Session. A Member Session cannot access this route.

Query:

- status: optional PENDING, DISMISSED, HIDDEN, or RESTORED;
- limit: optional integer from 1 to 20; default 20;
- cursor: optional opaque cursor.

The response contains grouped Report Case summaries, Reporter Entry counts,
the reported Message identifier, status, and timestamps. It does not include
Conversation history or Message text.

Missing or disabled Admin authentication returns 401 UNAUTHORIZED or 403
ADMIN_DISABLED. Invalid paging or status returns 400 VALIDATION.

### Read Report Case evidence as an Admin

GET /api/v1/admin/chat-reports/:caseId/evidence

Requires an enabled Admin Session. Opening evidence writes an immutable Admin
Action in the same operation boundary as the evidence read.

The response contains the reported Message, at most 20 visible Messages before
and after it, the grouped Reporter Entries needed for moderation, and the
current case status. It contains no unrelated Conversation data. Missing or
unauthorized cases return 404 REPORT_CASE_NOT_FOUND.

### Moderate a Report Case as an Admin

POST /api/v1/admin/chat-reports/:caseId/dismiss
POST /api/v1/admin/chat-reports/:caseId/hide
POST /api/v1/admin/chat-reports/:caseId/restore

These routes have no request body. Each valid operation writes the Moderation
Decision and its Admin Action atomically. The response returns the updated case
summary.

Allowed transitions are PENDING to DISMISSED, PENDING to HIDDEN, and HIDDEN to
RESTORED. An invalid transition returns 409 INVALID_REPORT_STATE. A missing
case returns 404 REPORT_CASE_NOT_FOUND. Hiding replaces the Message content
with a fixed placeholder for Members and blocks Member Attachment links;
authorized Admin evidence remains available.

## WebSocket protocol

### Connection and subscription

GET /api/v1/chat/ws upgrades only for a valid Better Auth Member Session. The
Session is read from the existing cookie during the upgrade. A token in a
query string or a Message payload is not accepted.

No valid Member Session rejects the upgrade with HTTP 401 UNAUTHORIZED. An
Admin Session is not a Member Session. A Session that expires after upgrade
closes the connection with private close code 4401 and does not reconnect until
authentication succeeds again.

The WebSocket is a delivery channel, not a second Message or Read Cursor write
API. Clients send only these JSON control messages:

~~~json
{
  "type": "subscribe",
  "requestId": "request-id",
  "conversationId": "conversation-id"
}
~~~

~~~json
{
  "type": "unsubscribe",
  "requestId": "request-id",
  "conversationId": "conversation-id"
}
~~~

~~~json
{
  "type": "ack",
  "eventId": "event-id"
}
~~~

Message creation and Read Cursor advancement use their REST endpoints. This
keeps PostgreSQL commit as the acceptance boundary and avoids two write
contracts for the same domain action.

A successful subscription returns:

~~~json
{
  "type": "subscribed",
  "requestId": "request-id",
  "conversationId": "conversation-id"
}
~~~

An unauthorized or missing Conversation returns the same control error:

~~~json
{
  "type": "error",
  "requestId": "request-id",
  "code": "CONVERSATION_NOT_FOUND",
  "message": "Conversation not found"
}
~~~

The error does not reveal whether the Conversation exists. A departed Worker
cannot subscribe to live delivery and receives no later events. The server
removes a subscription when the Worker's Chat Membership ends.

### Events

Every event is sent only after the corresponding database transaction commits.

~~~json
{
  "type": "event",
  "eventId": "event-id",
  "eventType": "message.created",
  "conversationId": "conversation-id",
  "occurredAt": "2026-08-27T10:00:00.000Z",
  "data": {
    "message": {}
  }
}
~~~

The event types are:

- message.created: a committed Member-authored Message or System Message;
- conversation.state.changed: the Conversation became archived or read-only;
- read.cursor.changed: the current Member's Read Cursor changed on another
  device; no other Member receives this event;
- subscription.revoked: a generic control event before a departed Member's
  subscription is removed.

An eventId is stable for one event. The same event may be delivered more than
once. Clients deduplicate by eventId and Message identifier, then acknowledge
each received event. An acknowledgement confirms delivery to that connection;
it does not advance a Read Cursor. The server does not promise durable
delivery across a disconnect.

### Heartbeat and reconnect

The server sends a WebSocket ping frame every 30 seconds. The client responds
with a pong frame. The server closes a connection after two missed heartbeat
intervals.

The client reconnects with exponential delays of 1, 2, 4, 8, 16, and then 30
seconds until the connection succeeds. After reconnect:

1. authenticate and subscribe to each still-visible Conversation;
2. call Message history with after set to the last visible Message cursor;
3. merge REST results and WebSocket events by Message identifier and sequence;
4. treat REST as authoritative for missing history.

If WebSocket is unavailable, REST history, send, read, and Attachment-link
operations remain usable. While a Conversation is open, the client may poll
its REST history every 15 seconds. Polling and reconnect must not create
duplicate Messages or move a Read Cursor backwards.

The connection registry and event fan-out are process-local. MVP supports one
API instance only. Redis, pub/sub, a message broker, and horizontal
WebSocket fan-out are outside this contract.

## Limits

- one Work Conversation per Quest;
- at most 50 accepted Members per Quest;
- at most five Attachments per Message;
- at most 10 MB per Attachment;
- at most 4,000 characters of Message text;
- 20 Conversation summaries per inbox page;
- 50 Messages per history page;
- 60 Member-authored Messages per Member per rolling minute across Conversations;
- 10 Attachment uploads per Member per 10 minutes;
- 500 concurrent WebSocket connections and 100 committed Messages per second
  are the single-instance MVP targets.

Rate-limit state is scoped to one API instance. A rate-limited request returns
429 RATE_LIMITED and persists no Message, idempotency result, Attachment
consumption, reusable file record, or orphaned object.

## Retention and account deletion

The retention clock starts one year after the Quest's latest transition to
COMPLETED or CANCELLED. The current Quest contract has no terminal reopen
transition. If a future decision adds one, the Quest and Chat retention
contracts must be revised together before implementation.

An open Report Case holds the Message and Attachment evidence required for
moderation beyond normal expiry. After a case closes, its evidence remains for
90 days, then becomes eligible for deletion. A daily retryable process removes
expired Messages and object-storage files. It does not remove active or held
evidence.

Deleting a Member anonymizes the sender as Former member in Member-facing
history. The minimum identity linkage remains only while an open Report needs
it. The retention process must be confirmed against university policy before
production activation.

## Explicitly out of scope

- general Member-to-Member direct messaging;
- push or email notifications;
- horizontal WebSocket scaling, Redis, pub/sub, or a message broker;
- end-to-end encryption;
- Message edit, sender delete, reply, reaction, or search;
- typing indicators, presence, and last seen;
- Member-visible read receipts;
- automatic account suspension or Quest removal;
- video and arbitrary file formats;
- public Attachment URLs;
- Admin joining or sending in a Work Conversation;
- changing the Quest owner or reopening a Terminal Quest.
