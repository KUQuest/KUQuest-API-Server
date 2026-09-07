# Work Chat REST and WebSocket contract

> **Legacy workflow reference.** The product source of truth is
> `docs/rulebook/quest/quest-work-chat-rulebook.md`, including §Resolved Quest lifecycle.
> This file retains the earlier REST/WebSocket model. Do not use its Quest,
> proof, notification, or moderation rules to define new behavior.

This is the earlier contract for the Work Chat MVP. It defines the private
Conversation associated with a Quest, the REST read and write surfaces, and the
single-instance WebSocket delivery protocol.

The contract uses the repository terms in CONTEXT.md: Member, Hirer, Worker,
Accepted Participant, Work Conversation, Chat Membership, Message, Attachment,
Read Cursor, System Message, Report Case, Reporter Entry, Moderation Decision,
Evidence Reference, and Admin Action.

## Scope and ownership

One Work Conversation exists for one Quest. The first Worker to become an
Accepted Participant creates the Conversation and the Hirer joins it in the
same Quest transaction. Later Workers become Accepted Participants in the same
Conversation.

Quest owns the Hirer, Worker, Assignment, Quest Status, and Accepted Participant
membership. Quest calls the typed Work Chat membership writer from the same
database transaction that changes the Quest. Work Chat does not fetch
membership over HTTP and does not keep an independently editable roster. See
ADR 0005, Quest owns Work Chat membership.

Work Chat owns Conversation, Message, Attachment, and Read Cursor persistence.
Trust & Safety owns Report Case, Reporter Entry, Moderation Decision, and
Evidence Reference records.
Admin Infra owns the Admin Action audit record required for moderation.

The current Quest domain contract has no transition that reopens a Terminal
Quest. BE-118, BE-120, and BE-131 must treat a Terminal Quest as final for this
MVP. Their requirements must not require or implement Terminal Quest reopening.
In this document, rejoin means that a departed Worker becomes an Accepted
Participant again while the Quest is not terminal. Rejoin creates a new Chat
Membership window; it does not reactivate a Terminal Quest or create a second
Conversation. If a future decision adds reopening, the Quest, Chat, and
retention contracts and their ADRs must be revised together before
implementation.

## Domain model

### Conversation

A Conversation has one immutable Quest reference. It contains:

- the current Accepted Participants: the Hirer and Active Workers;
- historical Chat Membership windows for departed Workers;
- ordered Member-authored Messages and immutable System Messages;
- archived and read-only state derived from Quest lifecycle.

The Conversation is created when the first Worker becomes an Accepted
Participant. It is not
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

### Evidence Reference

An Evidence Reference links a Report Case to a retained Message or Attachment
needed for moderation. It stores the domain record identifier and retention
hold state; it never copies Message text, file bytes, or signed URLs. The Admin
evidence route resolves Evidence References through a Report Case-scoped query.

### Temporal access

| Situation | Read access | Send access | WebSocket delivery |
| --- | --- | --- | --- |
| Current Accepted Participant | Full Conversation history | Yes, until the Conversation is read-only | Current committed events |
| Departed Worker | Messages created no later than leftAt | No | No later events |
| Accepted Participant after rejoin | Full Conversation history through the new window | Yes, while current | Current committed events |
| Candidate | No Conversation access | No | No subscription |
| Terminal Quest current Accepted Participant | Full retained history | No | Terminal System Message and state events, then `subscription.revoked`; no later events |

A departure closes the Worker's current Chat Membership at the supplied
leftAt. A reacceptance creates a new window and permits full history again.
The Terminal Quest current Accepted Participant row applies only to an Accepted
Participant whose Chat Membership was current when the Quest became terminal.
A Departed Worker keeps the leftAt visibility limit after the Quest becomes
terminal.
Access is evaluated in the database query for every read, Message, Attachment,
and Reporter Entry operation.

Membership and lifecycle transitions create immutable System Messages:
Accepted Participant joined, Worker departed, and the Conversation becoming
read-only because the Quest became COMPLETED or CANCELLED. A rejoin is recorded
as a new Accepted Participant joined System Message. A Terminal Quest cannot
reopen in the current MVP contract.

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
- an inaccessible or missing Reporter Entry returns 404
  REPORTER_ENTRY_NOT_FOUND;
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
Message text, Reporter Entry detail, file bytes, signed URLs, Session tokens, or
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
Reporter Entry, Report Case, event, and Quest identifiers are opaque server
values. Clients must not decode or construct them.

Member routes use authGuard and the Member security scheme. Admin routes use
the Admin authentication guard and the Admin security scheme. Request bodies,
parameters, and queries reject unknown fields and invalid values. As in the
existing Elysia contract, request validation runs before the authentication
hook; a malformed request may therefore return 400 VALIDATION before an
anonymous request reaches 401 UNAUTHORIZED.

The common errors apply to every route in the matching family: Member routes
return 401 UNAUTHORIZED for a missing or invalid Member Session and 429
RATE_LIMITED when the route limit is exceeded. Admin routes return 401
UNAUTHORIZED for a missing or invalid Admin Session, 403 ADMIN_DISABLED for a
disabled Admin, and 429 RATE_LIMITED when the route limit is exceeded. A route
with request input returns 400 VALIDATION for malformed or unknown input. A
route with a resource identifier applies the 404 non-disclosure rules above.
The route sections below list each route's additional resource, conflict,
payload, and infrastructure errors.

The current shared response helper lists 400, 401, 404, 409, 413, 415, and 502.
Before any Chat route implementation, extend the shared `responses` helper to
accept HTTP 403 and 429 and map both to the existing `apiErrorSchema` envelope.
Chat routes use 403 for an authenticated but disallowed caller, such as
`ADMIN_DISABLED`, and 429 `RATE_LIMITED` for a rate-limited request.

Admin Chat routes require an enabled Admin Session. A missing or invalid
Session returns 401 UNAUTHORIZED. A disabled Admin returns 403
ADMIN_DISABLED.

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

### Reporter Entry

~~~json
{
  "id": "reporter-entry-id",
  "messageId": "message-id",
  "reason": "HARASSMENT",
  "detail": "Optional explanation",
  "caseStatus": "PENDING",
  "createdAt": "2026-08-27T10:00:00.000Z",
  "updatedAt": "2026-08-27T10:00:00.000Z"
}
~~~

detail is nullable. caseStatus is the status of the Report Case that contains
the Reporter Entry. Member responses never include another reporter's
identity.

### Report Case summary

~~~json
{
  "id": "case-id",
  "messageId": "message-id",
  "status": "PENDING",
  "reporterEntryCount": 2,
  "createdAt": "2026-08-27T10:00:00.000Z",
  "updatedAt": "2026-08-27T10:00:00.000Z"
}
~~~

### Moderation Decision

~~~json
{
  "id": "decision-id",
  "action": "HIDE",
  "previousStatus": "PENDING",
  "newStatus": "HIDDEN",
  "adminId": "admin-id",
  "createdAt": "2026-08-27T10:00:00.000Z"
}
~~~

An Admin Action is an audit record and is not returned as a full object by the
Member or Admin routes. Evidence and moderation routes create it as described
below.

### Admin evidence

The `reportedMessage`, `messagesBefore`, and `messagesAfter` values use the
Message shape. `messagesBefore` and `messagesAfter` are retained context
Messages that are visible to Members. Hidden context Messages are excluded.
Admin evidence contains the original text for the reported Message, including
text that Members see as a hidden placeholder. Its Attachment values contain
metadata only and a `linkAvailable` boolean; the signed link is returned by the
separate Admin evidence link route. A Message deleted by retention is not
included. The response is:

~~~json
{
  "success": true,
  "data": {
    "case": {
      "id": "case-id",
      "messageId": "message-id",
      "status": "PENDING",
      "reporterEntryCount": 2,
      "createdAt": "2026-08-27T10:00:00.000Z",
      "updatedAt": "2026-08-27T10:00:00.000Z"
    },
    "reportedMessage": {
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
          "createdAt": "2026-08-27T10:00:00.000Z",
          "linkAvailable": true
        }
      ],
      "systemType": null,
      "createdAt": "2026-08-27T10:00:00.000Z"
    },
    "messagesBefore": [],
    "messagesAfter": [],
    "reporterEntries": [
      {
        "id": "reporter-entry-id",
        "reporter": {
          "id": "reporter-member-id",
          "displayName": "Reporter name"
        },
        "messageId": "message-id",
        "reason": "HARASSMENT",
        "detail": "Optional explanation",
        "createdAt": "2026-08-27T10:00:00.000Z",
        "updatedAt": "2026-08-27T10:00:00.000Z"
      }
    ]
  }
}
~~~

messagesBefore and messagesAfter contain at most 20 retained context Messages
each and are ordered by Conversation sequence ascending. They contain only
Messages visible to Members. An Admin evidence Attachment link is available
only when the Attachment belongs to one of these Messages and is still
retained.

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

before and after are mutually exclusive. Providing both returns 400 VALIDATION.
Without a cursor, the server returns the newest page. Items inside a page are
ordered by Conversation sequence ascending. nextCursor points to the next page
in the selected direction, and hasMore states whether that page exists.

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
Missing or invalid Member authentication returns 401 UNAUTHORIZED. Missing or
unauthorized Conversations return 404 CONVERSATION_NOT_FOUND. The query never
returns Messages outside the caller's temporal visibility window.

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
WebSocket event. The complete success response is:

~~~json
{
  "success": true,
  "data": {
    "message": {
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
  }
}
~~~

For an Attachment-only Message, text is null and attachments is non-empty.
For an idempotent replay, the response is the same 200 envelope and the same
complete data.message values as the original request: the server returns the
original Message identifier, sequence, timestamps, text, and Attachments. It
does not create another Message or publish another Message event.

The same Member, Conversation, and clientMessageId with the same content
returns the original Message. Reusing clientMessageId with different content
returns 409 CLIENT_MESSAGE_ID_REUSED. A missing or invalid Member Session
returns 401 UNAUTHORIZED. A rate-limited request returns 429 RATE_LIMITED. A
departed or non-member caller receives 404 CONVERSATION_NOT_FOUND. A Terminal
Quest Conversation returns 409 CONVERSATION_READ_ONLY. An unavailable
Attachment returns 404 ATTACHMENT_NOT_FOUND. Invalid or unknown request input
returns 400 VALIDATION; invalid content returns 400 MESSAGE_CONTENT_REQUIRED
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
    "messageId": "stored-furthest-message-id"
  }
}
~~~

The response always returns the stored furthest Read Cursor for this Member
and Conversation after the operation. If the requested Message is older than
the stored cursor, the operation is a no-op and messageId is the stored cursor,
not the older requested Message ID.

Missing, other-Conversation, or invisible Messages return 404
MESSAGE_NOT_FOUND. Missing or invalid Member authentication returns 401
UNAUTHORIZED. A missing or unauthorized Conversation returns 404
CONVERSATION_NOT_FOUND. Invalid request bodies return 400 VALIDATION. A
rate-limited request returns 429 RATE_LIMITED. The Read Cursor is never
exposed as a read receipt to other Members.

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
no reusable Attachment identifier is returned. Missing, multiple, or empty file
fields return 400 VALIDATION. The response is:

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
storage. Missing or invalid Member authentication returns 401 UNAUTHORIZED.
The complete error set is 400 VALIDATION for missing, multiple, or empty file
fields, 401 UNAUTHORIZED, 404 CONVERSATION_NOT_FOUND, 409
CONVERSATION_READ_ONLY, 413 ATTACHMENT_TOO_LARGE, 415
UNSUPPORTED_ATTACHMENT_TYPE, 429 RATE_LIMITED, 502
ATTACHMENT_SCAN_UNAVAILABLE, and 502 ATTACHMENT_UPLOAD_FAILED.

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
and clients use expiresAt rather than assuming a fixed lifetime. Missing or
invalid Member authentication returns 401 UNAUTHORIZED. This route has no
query or request body, so it has no input-validation error. Missing, hidden,
rejected, quarantined, expired, or unauthorized Attachments return 404
ATTACHMENT_NOT_FOUND. A rate-limited request returns 429 RATE_LIMITED.

### Submit a Reporter Entry

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
characters. A Member may create one Reporter Entry for one Message. Any later
submission for the same Member and Message returns the existing Reporter Entry
without changing its reason or detail. Unknown fields are rejected.

The response is 200 with:

~~~json
{
  "success": true,
  "data": {
    "reporterEntry": {
      "id": "reporter-entry-id",
      "messageId": "message-id",
      "reason": "HARASSMENT",
      "detail": "Optional explanation",
      "caseStatus": "PENDING",
      "createdAt": "2026-08-27T10:00:00.000Z",
      "updatedAt": "2026-08-27T10:00:00.000Z"
    }
  }
}
~~~

An invisible, expired, or missing Message returns 404 MESSAGE_NOT_FOUND.
Invalid input returns 400 VALIDATION. A missing or invalid Member Session
returns 401 UNAUTHORIZED. A rate-limited request returns 429 RATE_LIMITED. The
Reporter Entry response never contains another reporter's identity or the
moderation evidence.

### List own Reporter Entries

GET /api/v1/chat/reports

Requires a Member Session.

Query:

- limit: optional integer from 1 to 50; default 20;
- cursor: optional opaque cursor from the previous response.

The server orders Reporter Entries by createdAt descending, then by Reporter
Entry identifier descending. The cursor is scoped to this endpoint and the
current Member. Clients must not decode or construct it. A nextCursor is
returned only when another page exists. The response contains only the current
Member's Reporter Entries:

~~~json
{
  "success": true,
  "data": {
    "items": [
      {
        "id": "reporter-entry-id",
        "messageId": "message-id",
        "reason": "HARASSMENT",
        "detail": "Optional explanation",
        "caseStatus": "PENDING",
        "createdAt": "2026-08-27T10:00:00.000Z",
        "updatedAt": "2026-08-27T10:00:00.000Z"
      }
    ],
    "nextCursor": null
  }
}
~~~

An absent or empty collection is successful. An invalid limit returns 400
INVALID_LIMIT. A malformed, cross-Member, wrong-endpoint, or unusable cursor
returns 400 INVALID_CURSOR. A missing or invalid Member Session returns 401
UNAUTHORIZED. A rate-limited request returns 429 RATE_LIMITED. No other
Member's Reporter Entry is returned.

### Get one own Reporter Entry

GET /api/v1/chat/reports/:reporterEntryId

Requires a Member Session. A missing or another Member's Reporter Entry
returns 404 REPORTER_ENTRY_NOT_FOUND. The response is:

~~~json
{
  "success": true,
  "data": {
    "reporterEntry": {
      "id": "reporter-entry-id",
      "messageId": "message-id",
      "reason": "HARASSMENT",
      "detail": "Optional explanation",
      "caseStatus": "PENDING",
      "createdAt": "2026-08-27T10:00:00.000Z",
      "updatedAt": "2026-08-27T10:00:00.000Z"
    }
  }
}
~~~

The response does not include another reporter's identity or moderation
evidence. A missing or invalid Member Session returns 401 UNAUTHORIZED.

### List Report Cases as an Admin

GET /api/v1/admin/chat-reports

Requires an enabled Admin Session. A Member Session cannot access this route.

Query:

- status: optional PENDING, DISMISSED, HIDDEN, or RESTORED;
- limit: optional integer from 1 to 20; default 20;
- cursor: optional opaque cursor.

The status filter is applied before pagination. The server orders Report Cases
by updatedAt descending, then by Report Case identifier descending. The cursor
is scoped to this endpoint and the selected status filter. Clients must not
decode or construct it. A nextCursor is returned only when another page exists.
The response is:

~~~json
{
  "success": true,
  "data": {
    "items": [
      {
        "id": "case-id",
        "messageId": "message-id",
        "status": "PENDING",
        "reporterEntryCount": 2,
        "reporterEntries": [
          {
            "id": "reporter-entry-id",
            "reason": "HARASSMENT",
            "createdAt": "2026-08-27T10:00:00.000Z"
          },
          {
            "id": "reporter-entry-id-2",
            "reason": "SPAM",
            "createdAt": "2026-08-27T10:05:00.000Z"
          }
        ],
        "createdAt": "2026-08-27T10:00:00.000Z",
        "updatedAt": "2026-08-27T10:00:00.000Z"
      }
    ],
    "nextCursor": null
  }
}
~~~

Each queue item includes one `reporterEntries` summary for each Reporter Entry.
A summary contains the Reporter Entry identifier, reason, and creation time. It
does not contain Message content, Attachment data, or a signed link. Full
Reporter Entry detail and reporter identity are available only in Admin
evidence.

An absent or empty queue is successful. An invalid status returns 400
INVALID_STATUS. An invalid limit returns 400 INVALID_LIMIT. A malformed,
wrong-filter, or unusable cursor returns 400 INVALID_CURSOR.

Missing or invalid Admin authentication returns 401 UNAUTHORIZED. A disabled
Admin returns 403 ADMIN_DISABLED. Unknown query fields return 400 VALIDATION.
A rate-limited request returns 429 RATE_LIMITED.

### Read Report Case evidence as an Admin

GET /api/v1/admin/chat-reports/:caseId/evidence

Requires an enabled Admin Session. This route has no query or request body.
Opening evidence writes an immutable Admin Action in the same operation
boundary as the evidence read.

The response uses the Admin evidence shape defined above. It contains the
reported Message, at most 20 visible Messages before and after it, the grouped
Reporter Entries needed for moderation, and the current Report Case status. It
contains no unrelated Conversation data. The arrays are bounded and ordered by
Conversation sequence ascending. This route does not paginate and does not
accept or return a cursor.

A missing or unauthorized Report Case returns 404 REPORT_CASE_NOT_FOUND. A
case whose retained evidence is no longer available returns 409
EVIDENCE_NOT_AVAILABLE. Missing or invalid Admin authentication returns 401
UNAUTHORIZED. A disabled Admin returns 403 ADMIN_DISABLED. A rate-limited
request returns 429 RATE_LIMITED.

### Get an Admin evidence Attachment link

GET /api/v1/admin/chat-reports/:caseId/evidence/attachments/:attachmentId/link

Requires an enabled Admin Session. This route has no query or request body.
The server scopes the Attachment lookup to the Report Case and to the reported
Message or one of the bounded context Messages returned by the evidence route.
It writes an immutable Admin Action in the same operation boundary as the link
creation.

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

The link is available only for a clean, retained Attachment. It is short-lived
and never persisted. A missing or unauthorized Report Case returns 404
REPORT_CASE_NOT_FOUND. An Attachment that is not part of the case evidence,
or is missing, expired, rejected, quarantined, or deleted, returns 404
ATTACHMENT_NOT_FOUND. A case whose evidence is no longer available returns 409
EVIDENCE_NOT_AVAILABLE. Missing or invalid Admin authentication returns 401
UNAUTHORIZED. A disabled Admin returns 403 ADMIN_DISABLED. A rate-limited
request returns 429 RATE_LIMITED.

### Moderate a Report Case as an Admin

POST /api/v1/admin/chat-reports/:caseId/dismiss
POST /api/v1/admin/chat-reports/:caseId/hide
POST /api/v1/admin/chat-reports/:caseId/restore

These routes have no request body or cursor. Unknown fields or a non-empty body
return 400 VALIDATION. Each valid operation writes the Moderation Decision and
its Admin Action atomically. The response is:

~~~json
{
  "success": true,
  "data": {
    "case": {
      "id": "case-id",
      "messageId": "message-id",
      "status": "HIDDEN",
      "reporterEntryCount": 2,
      "createdAt": "2026-08-27T10:00:00.000Z",
      "updatedAt": "2026-08-27T10:00:00.000Z"
    },
    "decision": {
      "id": "decision-id",
      "action": "HIDE",
      "previousStatus": "PENDING",
      "newStatus": "HIDDEN",
      "adminId": "admin-id",
      "createdAt": "2026-08-27T10:00:00.000Z"
    }
  }
}
~~~

The `/dismiss` route allows only PENDING to DISMISSED. The `/hide` route allows
only PENDING to HIDDEN. The `/restore` route allows only HIDDEN to RESTORED.
PENDING and HIDDEN are open Report Case statuses. DISMISSED and RESTORED are
closed statuses. The transition to DISMISSED or RESTORED sets `caseClosedAt`
atomically with the Moderation Decision. `caseClosedAt` is null while the case
is PENDING or HIDDEN, and the 90-day post-case grace starts at that timestamp.
An invalid or repeated transition returns 409 INVALID_REPORT_STATE and creates
no decision. A missing or unauthorized Report Case returns 404
REPORT_CASE_NOT_FOUND. Hiding replaces the Message content with a fixed
placeholder for Members and blocks Member Attachment links; authorized Admin
evidence and the Admin evidence Attachment link remain available.

Missing or invalid Admin authentication returns 401 UNAUTHORIZED. A disabled
Admin returns 403 ADMIN_DISABLED. A rate-limited request returns 429 RATE_LIMITED.

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

A control message is a JSON object with no unknown fields. `subscribe` and
`unsubscribe` require a non-empty requestId of at most 128 characters and an
opaque conversationId. `ack` requires an opaque eventId. A control message
with invalid JSON, an unknown type, a missing field, an invalid identifier, or
an unknown field returns this error and does not change the connection:

~~~json
{
  "type": "error",
  "requestId": null,
  "code": "INVALID_CONTROL_MESSAGE",
  "message": "Invalid WebSocket control message"
}
~~~

The server echoes a valid requestId in the error. It returns null when the
requestId is missing or invalid. The connection remains open after this error.

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

A successful unsubscription returns:

~~~json
{
  "type": "unsubscribed",
  "requestId": "request-id",
  "conversationId": "conversation-id"
}
~~~

A duplicate `subscribe` or `unsubscribe` is idempotent. It returns the same
successful result and does not create a second subscription or fail when the
requested subscription is already absent. A requestId is scoped to one
connection. Repeating the same control message with that requestId returns the
same result. Reusing the requestId with a different control message returns:

~~~json
{
  "type": "error",
  "requestId": "request-id",
  "code": "REQUEST_ID_REUSED",
  "message": "Request ID was already used"
}
~~~

A valid `ack` returns:

~~~json
{
  "type": "acknowledged",
  "eventId": "event-id"
}
~~~

An acknowledgement for an unknown or already acknowledged event is a
successful no-op with the same response. It does not replay an event or move a
Read Cursor.

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
removes a subscription when the Worker's Chat Membership ends. It sends a
`subscription.revoked` event before it removes that subscription.

When a subscribed Conversation becomes terminal, the server completes the
database transaction first. For every active subscription, it then sends these
events in order:

1. the terminal System Message as `message.created`;
2. `conversation.state.changed` with `archived: true` and `readOnly: true`;
3. `subscription.revoked` with reason `CONVERSATION_READ_ONLY`.

The server removes the subscription only after the revocation event. The
current Accepted Participant can still read the retained Conversation through
REST after revocation, but receives no later WebSocket events. A membership
departure sends `subscription.revoked` with `MEMBERSHIP_ENDED` before removal;
it does not send the terminal state sequence unless the same committed Quest
transition also makes the Conversation terminal.

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
- subscription.revoked: a control event before a Worker's subscription is
  removed because the Worker's Chat Membership ended or the Conversation
  became read-only.

The `data` payload for each event type is:

- `message.created`: `{ "message": <Message> }`;
- `conversation.state.changed`:
  `{ "previousQuestStatus": "IN_PROGRESS", "questStatus": "COMPLETED", "archived": true, "readOnly": true }`;
- `read.cursor.changed`:
  `{ "messageId": "visible-message-id", "sequence": 42 }`;
- `subscription.revoked`:
  `{ "reason": "MEMBERSHIP_ENDED" }` or
  `{ "reason": "CONVERSATION_READ_ONLY" }`.

For `conversation.state.changed`, questStatus is COMPLETED or CANCELLED and
archived and readOnly are both true. For `read.cursor.changed`, the event is
sent only to the same Member's other subscribed connections. No non-message
event contains Message text, Attachment bytes, or a signed URL.

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
- at most 50 Accepted Participants per Quest, including the Hirer;
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

The retention policy uses these timestamps:

- `latestTerminalAt` is the time of the Quest's latest transition to
  `COMPLETED` or `CANCELLED`;
- `caseClosedAt` is the time that a Report Case changes to DISMISSED or
  RESTORED. It is null while the case is PENDING or HIDDEN.

A non-terminal Conversation is not eligible for retention cleanup. After the
Quest becomes terminal, the retention eligibility applies separately to each
Message and its Attachments:

~~~text
eligibleAt = latestTerminalAt + 1 year
~~~

For a Message held by a Report Case, use the later of the normal retention date
and the post-case grace date:

~~~text
eligibleAt = max(latestTerminalAt + 1 year, caseClosedAt + 90 days)
~~~

An open Report Case holds every Message and Attachment named by its Evidence
References beyond normal expiry. The default references are the reported
Message and its Attachments. Context Messages are included only while they
remain retained under their own retention rule, unless the Report Case has an
Evidence Reference for them. A daily retryable process may remove retained
Messages and object-storage files at or after `eligibleAt`. It does not remove
active or held evidence. If a Message has more than one active hold, it remains
held until every hold has ended.

The current Quest contract has no terminal reopen transition. If a future
decision adds one, the Quest and Chat retention contracts must be revised
together before implementation.

Deleting a Member anonymizes the sender as Former member in Member-facing
history. The minimum identity linkage remains only while an open Report Case
needs it. The retention process must be confirmed against university policy before
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
