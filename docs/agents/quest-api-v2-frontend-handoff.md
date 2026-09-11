# Quest v2 Frontend Agent Handoff

This file is the frontend integration contract for the current Quest v2 HTTP
API. A frontend agent must be able to implement the Quest flow from this file.
The frontend agent must not infer missing behavior from old Quest v1 docs or
from backend source code.

The contract uses the domain terms from CONTEXT.md:

- Hirer: the Member who creates and funds a Quest.
- Worker: the Member who has an active Assignment.
- Prospective Worker: a Member who may join, apply, or form a Candidate Team.
- Candidate: the role used by a Candidate-mode Quest.
- Accepted Participant: a Worker after the Assignment is active.
- Quest: the work opportunity.
- Condition Item: one item in the Quest condition list.
- Assignment: the relationship between a Quest and an accepted Worker.
- Work Chat: the conversation for an assigned Quest.
- Candidate Inquiry Conversation: the pre-assignment conversation.
- Proof Submission: work evidence submitted by a Worker.
- Rating Review: a review after a terminal Quest state.
- Quest Funding Total: the inclusive amount entered by the Hirer.
- Quest Reward: the amount paid to one Worker for one slot.

The current route set is mounted under /api/v2.
The contract in this file is current for 2026-09-08.

## 1. How to use this document

1. Read the common HTTP rules.
2. Identify the actor, Quest State, mode, and participation.
3. Select one lifecycle branch.
4. Send only the fields listed for the endpoint.
5. Read the response envelope.
6. Refresh the relevant resource after a command or conflict.
7. Check the completion criteria at the end.

The frontend agent must complete each step with a checkable result:

- The request has the correct path, headers, body, and role.
- The response is parsed from the data property.
- The returned state is rendered as the source of truth.
- A documented error code has a safe UI action.

## 2. Common HTTP rules

### 2.1 Response envelope

Every successful response uses one of these shapes:

~~~json
{ "success": true }
~~~

~~~json
{ "success": true, "data": { } }
~~~

Every error uses this shape:

~~~json
{
  "success": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable message"
  }
}
~~~

Read business fields from data.
Branch on error.code, not on error.message.

### 2.2 Authentication

All Quest v2 routes require an authenticated Member session.
Send the same session credentials used by the rest of the application.
The public Quest detail endpoint is also authenticated.

The server checks the role and relationship on every command.
A frontend route guard is not authorization.

### 2.3 Content types

Use application/json for JSON bodies.
Use multipart/form-data for file upload endpoints.
Let the browser set the multipart boundary.
Do not set the multipart boundary manually.

### 2.4 Idempotency

Every state-changing command requires this header:

~~~http
Idempotency-Key: unique-non-blank-key
~~~

The key must be at most 200 characters.
Use a new key for each logical user action.
If a request may have reached the server, retry with the same key and the same
body. Do not retry with a new key until the first action is known not to have
completed.

Common idempotency errors:

- IDEMPOTENCY_KEY_REQUIRED: header is missing.
- INVALID_IDEMPOTENCY_KEY: header is blank or invalid.
- IDEMPOTENCY_KEY_REUSED: same key has a different request fingerprint.
- IDEMPOTENCY_IN_PROGRESS: the first request is still processing.
- IDEMPOTENCY_UNAVAILABLE: the stored result cannot be returned.

### 2.5 Date and time

Quest schedule values use Bangkok time with an explicit +07:00 offset.
Use RFC3339 date-time text.
Input accepts zero to three fractional digits.
Quest responses use three fractional digits.

Example:

~~~text
2026-09-30T09:00:00+07:00
~~~

Do not send a local date without an offset.
Do not send a UTC value with a Z suffix for Quest schedule fields.

### 2.6 Money

Quest money input and normal Quest money output use Baht as JSON numbers.
The value must have at most two decimal digits.
Escrow and settlement responses also include exact integer Satang fields.
Use Satang fields for exact calculations.
Do not calculate settlement with binary floating point.

Quest Funding Total is the inclusive amount for one Worker slot.
The server calculates Quest Reward and Platform Fee with integer Satang.
The server reserves Quest Funding Total multiplied by headcount.

### 2.7 Unknown fields

The request schemas reject unknown fields.
Send only fields listed in this document.

### 2.8 Optimistic concurrency

Draft edit uses the If-Match header.
Use the version from the latest CanonicalQuest:

~~~http
If-Match: 3
~~~

A plain positive integer is the preferred format.
After a successful edit, replace the local Quest with the returned Quest.
Do not increment version locally.

### 2.9 Temporary image URLs

Quest image url values are temporary links.
They expire about 15 minutes after they are materialized.
Call Quest detail again when a link expires.
Do not store a temporary URL as a permanent asset URL.

## 3. Quest states and lifecycle

The Quest State values are:

~~~text
QUEST_DRAFT
QUEST_OPEN
QUEST_ASSIGNED
QUEST_IN_PROGRESS
QUEST_COMPLETED
QUEST_CANCELLED
QUEST_FAILED
~~~

The normal lifecycle is:

~~~text
QUEST_DRAFT -> QUEST_OPEN -> QUEST_ASSIGNED -> QUEST_IN_PROGRESS -> QUEST_COMPLETED

QUEST_OPEN, QUEST_ASSIGNED, or QUEST_IN_PROGRESS -> QUEST_CANCELLED
QUEST_IN_PROGRESS -> QUEST_FAILED
~~~

The backend owns all state transitions.
The frontend must render the state returned by the server.

### Important: no v2 Start Work endpoint

There is no endpoint named Start Work in the current Quest v2 API.
There is no POST /api/v2/quests/:questId/start route.
Do not invent or call one.

When a Quest is QUEST_ASSIGNED and startTime is due, the backend lifecycle
worker changes it to QUEST_IN_PROGRESS.
The worker also sets startedAt on active Assignments.
The transition can be delayed by worker scheduling.
Poll or refresh the Quest and Assignment with the application's normal refresh
mechanism.

A pending Quest Edit prevents the assigned-to-in-progress transition.

## 4. Select the correct lifecycle branch

Before planning a screen, identify these facts:

1. Actor: Hirer, Worker, Prospective Worker, Candidate, or another Accepted
   Participant.
2. Quest State.
3. Quest mode.
4. Participation: SINGLE or GROUP.
5. proofRequired and dueAt for work and completion screens.

Use this table:

| Known condition | Use this branch |
| --- | --- |
| Hirer is creating a Quest | Draft and publish |
| Any authenticated Member is browsing | Quest Board and public detail |
| FIRST_COME_FIRST_SERVED | Worker join |
| CANDIDATE plus SINGLE | Candidate application |
| CANDIDATE plus GROUP | Candidate Team |
| GROUP first-come Quest is not full at startTime | Underfilled decision and consent |
| Quest is assigned | Assignment, Work Chat, automatic start |
| Quest is in progress | Proof Submission or completion confirmation |
| Quest is terminal | Rating Review |

Do not apply a SINGLE rule to a GROUP Quest.
Do not apply a FIRST_COME_FIRST_SERVED rule to a CANDIDATE Quest.

## 5. Hirer journey: create, edit, add images, publish

The complete Hirer flow is:

~~~text
POST /quests
  -> GET /quests/mine or GET /quests/:questId
  -> PATCH /quests/:questId
  -> POST /quests/:questId/images
  -> GET /quests/:questId/publish-check
  -> POST /quests/:questId/publish
  -> Quest State becomes QUEST_OPEN
~~~

The flow is complete when the response from Publish contains a Quest with
state QUEST_OPEN and a Quest Escrow snapshot.

### 5.1 Create a Draft

Request:

~~~http
POST /api/v2/quests
Idempotency-Key: create-quest-client-action-id
Content-Type: application/json
~~~

~~~json
{
  "title": "Design a landing page",
  "description": "Create one responsive landing page.",
  "condition": {
    "items": [
      "Use the supplied brand colors",
      "Include a mobile layout"
    ]
  },
  "mode": "FIRST_COME_FIRST_SERVED",
  "participation": "SINGLE",
  "questFundingTotal": 1000.00,
  "headcount": 1,
  "startTime": "2026-09-30T09:00:00+07:00",
  "dueAt": "2026-10-07T18:00:00+07:00",
  "tagId": "00000000-0000-0000-0000-000000000000",
  "proofRequired": true,
  "locations": [
    { "label": "Online" }
  ]
}
~~~

Request fields:

| Field | Type | Required | Rule |
| --- | --- | --- | --- |
| title | string | yes | 1 to 120 characters after trim; not blank |
| description | string or null | no | Maximum 1000 characters; omitted or null becomes null |
| condition.items | string array | yes | At least one item; each item is 1 to 255 characters after trim |
| mode | enum | yes | FIRST_COME_FIRST_SERVED or CANDIDATE |
| participation | enum | yes | SINGLE or GROUP |
| questFundingTotal | number | yes | 1 to 700000 Baht; maximum two decimal digits |
| headcount | integer | yes | SINGLE requires 1; GROUP requires 2 to 20 |
| startTime | date-time | yes | Bangkok +07:00 schedule value |
| dueAt | date-time or null | no | If supplied, after startTime; Draft may be null |
| tagId | UUID or null | no | Existing Tag; null means no Tag |
| proofRequired | boolean | no | Defaults to true |
| locations | object array | no | Maximum 10 objects; each object is label with 1 to 100 characters |

The server trims text values.
The server converts Quest Funding Total from Baht to integer Satang.
The new Quest State is QUEST_DRAFT.

Success status: HTTP 200.
The data value is a complete CanonicalQuest.

Example response:

~~~json
{
  "success": true,
  "data": {
    "id": "quest-uuid",
    "version": 1,
    "hiddenAt": null,
    "title": "Design a landing page",
    "description": "Create one responsive landing page.",
    "condition": {
      "items": [
        { "position": 0, "text": "Use the supplied brand colors" },
        { "position": 1, "text": "Include a mobile layout" }
      ]
    },
    "tag": {
      "id": "tag-uuid",
      "name": "Design"
    },
    "mode": "FIRST_COME_FIRST_SERVED",
    "participation": "SINGLE",
    "state": "QUEST_DRAFT",
    "questFundingTotal": 1000,
    "headcount": 1,
    "startTime": "2026-09-30T09:00:00.000+07:00",
    "dueAt": "2026-10-07T18:00:00.000+07:00",
    "proofRequired": true,
    "locations": [
      { "label": "Online" }
    ],
    "createdAt": "2026-09-08T10:00:00.000+07:00",
    "updatedAt": "2026-09-08T10:00:00.000+07:00"
  }
}
~~~

The create response does not include Quest Images.
Call Quest detail if the screen needs the gallery.

Create errors:

- 400 VALIDATION
- 400 INVALID_TITLE
- 400 INVALID_DESCRIPTION
- 400 INVALID_CONDITION
- 400 INVALID_LOCATIONS
- 400 INVALID_HEADCOUNT
- 400 INVALID_QUEST_FUNDING_TOTAL
- 400 INVALID_QUEST_DATES
- 400 TAG_NOT_FOUND
- 400 IDEMPOTENCY_KEY_REQUIRED
- 400 INVALID_IDEMPOTENCY_KEY
- 409 IDEMPOTENCY_KEY_REUSED
- 409 IDEMPOTENCY_IN_PROGRESS
- 503 IDEMPOTENCY_UNAVAILABLE

### 5.2 List the Hirer’s Quests

Request:

~~~http
GET /api/v2/quests/mine?limit=20&cursor=opaque-cursor
~~~

Query fields:

| Query | Type | Default | Rule |
| --- | --- | --- | --- |
| limit | integer | 20 | 1 to 50 |
| cursor | string | none | Opaque value from nextCursor |

The list is sorted by startTime ascending and then id ascending.

Success status: HTTP 200.

~~~json
{
  "success": true,
  "data": {
    "items": [
      {
        "id": "quest-uuid",
        "version": 1,
        "state": "QUEST_DRAFT"
      }
    ],
    "nextCursor": "opaque-cursor-or-null"
  }
}
~~~

Each item is a complete CanonicalQuest without the image gallery.
The example is shortened. Use the CanonicalQuest shape in section 16.

### 5.3 Read the Hirer’s Quest detail

Request:

~~~http
GET /api/v2/quests/:questId
~~~

Only the owning Hirer can read this endpoint.

Success status: HTTP 200.
The data value is CanonicalQuest plus images.

~~~json
{
  "success": true,
  "data": {
    "id": "quest-uuid",
    "version": 1,
    "hiddenAt": null,
    "title": "Design a landing page",
    "description": "Create one responsive landing page.",
    "condition": {
      "items": [
        { "position": 0, "text": "Use the supplied brand colors" }
      ]
    },
    "tag": null,
    "mode": "FIRST_COME_FIRST_SERVED",
    "participation": "SINGLE",
    "state": "QUEST_DRAFT",
    "questFundingTotal": 1000,
    "headcount": 1,
    "startTime": "2026-09-30T09:00:00.000+07:00",
    "dueAt": "2026-10-07T18:00:00.000+07:00",
    "proofRequired": true,
    "locations": [],
    "createdAt": "2026-09-08T10:00:00.000+07:00",
    "updatedAt": "2026-09-08T10:00:00.000+07:00",
    "images": [
      {
        "imageId": "image-uuid",
        "fileId": "file-uuid",
        "position": 0,
        "url": "temporary-url",
        "urlExpiresAt": "2026-09-08T10:15:00.000+07:00"
      }
    ]
  }
}
~~~

Image fields:

| Field | Meaning |
| --- | --- |
| imageId | Quest Image identifier used by delete |
| fileId | Private File identifier |
| position | Zero-based gallery position |
| url | Temporary read URL |
| urlExpiresAt | Expiry time |

Errors:

- 404 QUEST_NOT_FOUND for a missing Quest or a Quest not owned by the caller.
- 503 QUEST_IMAGE_STORAGE_UNAVAILABLE when links cannot be materialized.

### 5.4 Edit a Draft

Request:

~~~http
PATCH /api/v2/quests/:questId
Idempotency-Key: edit-quest-client-action-id
If-Match: 1
Content-Type: application/json
~~~

The body is a partial Draft update.
It must contain at least one field.
Omitted fields stay unchanged.
Nullable fields set to null clear their value.
condition.items and locations are full replacements.

All create fields can be edited:

~~~json
{
  "title": "New title",
  "description": null,
  "condition": {
    "items": [
      "New condition"
    ]
  },
  "mode": "CANDIDATE",
  "participation": "GROUP",
  "questFundingTotal": 1200.50,
  "headcount": 3,
  "startTime": "2026-10-01T09:00:00+07:00",
  "dueAt": null,
  "tagId": null,
  "proofRequired": false,
  "locations": [
    { "label": "Bangkok" }
  ]
}
~~~

Only an owned QUEST_DRAFT can be edited.
The server checks If-Match against version.
The server increments version after a successful edit.

Success status: HTTP 200.
The data value is a complete CanonicalQuest.

Errors:

- 400 VALIDATION
- 400 INVALID_VERSION
- 400 INVALID_TITLE
- 400 INVALID_DESCRIPTION
- 400 INVALID_CONDITION
- 400 INVALID_LOCATIONS
- 400 INVALID_HEADCOUNT
- 400 INVALID_QUEST_FUNDING_TOTAL
- 400 INVALID_QUEST_DATES
- 400 TAG_NOT_FOUND
- 404 QUEST_NOT_FOUND
- 409 QUEST_NOT_DRAFT
- 409 QUEST_EDIT_CONFLICT
- idempotency errors

On INVALID_VERSION or QUEST_EDIT_CONFLICT, read the latest Quest.
Do not overwrite the latest version blindly.

### 5.5 Add Quest Images

Request:

~~~http
POST /api/v2/quests/:questId/images
Idempotency-Key: add-quest-images-client-action-id
Content-Type: multipart/form-data
~~~

Use a multipart field named images.
Send one to three files in request order.

File rules:

- decoded type must be JPEG, PNG, or WebP;
- maximum size per file is 5 MB;
- maximum Quest Image count after the command is 3;
- files append to the ordered gallery;
- the whole batch is validated before any file is attached.

Only an owned QUEST_DRAFT can receive images.
Delete an image before uploading a replacement when the gallery is full.

Success status: HTTP 200.

~~~json
{
  "success": true,
  "data": {
    "images": [
      {
        "imageId": "image-uuid",
        "fileId": "file-uuid",
        "position": 0,
        "url": "temporary-url",
        "urlExpiresAt": "2026-09-08T10:15:00.000+07:00"
      }
    ]
  }
}
~~~

The images array is the complete gallery after the command.

Errors:

- 404 QUEST_NOT_FOUND
- 409 QUEST_NOT_DRAFT
- 409 QUEST_IMAGE_LIMIT_REACHED
- 413 IMAGE_TOO_LARGE
- 415 UNSUPPORTED_IMAGE_TYPE
- 503 QUEST_IMAGE_STORAGE_UNAVAILABLE
- idempotency errors

### 5.6 Delete a Quest Image

Request:

~~~http
DELETE /api/v2/quests/:questId/images/:imageId
Idempotency-Key: delete-quest-image-client-action-id
~~~

Only the owning Hirer can delete an image from an owned QUEST_DRAFT.
The server soft-deletes image metadata and repacks remaining positions from
zero.

Success status: HTTP 200.
The data value is:

~~~json
{
  "images": [
    {
      "imageId": "image-uuid",
      "fileId": "file-uuid",
      "position": 0,
      "url": "temporary-url",
      "urlExpiresAt": "2026-09-08T10:15:00.000+07:00"
    }
  ]
}
~~~

Errors:

- 404 QUEST_NOT_FOUND
- 404 QUEST_IMAGE_NOT_FOUND
- 409 QUEST_NOT_DRAFT
- idempotency errors
- 503 QUEST_IMAGE_STORAGE_UNAVAILABLE

### 5.7 Check publish requirements

Request:

~~~http
GET /api/v2/quests/:questId/publish-check
~~~

Only the owning Hirer can check an owned QUEST_DRAFT.
There is no body and no idempotency key.

Success status: HTTP 200.

~~~json
{
  "success": true,
  "data": {
    "blockingReasons": [
      {
        "code": "QUEST_DUE_AT_REQUIRED",
        "message": "dueAt is required before publishing"
      }
    ],
    "warnings": [],
    "canPublish": false,
    "questFundingTotal": 1000,
    "questFundingTotalSatang": 100000,
    "questReward": 980,
    "questRewardSatang": 98000,
    "platformFee": 20,
    "platformFeeSatang": 2000,
    "escrowRequirement": 1000,
    "escrowRequirementSatang": 100000,
    "headcount": 1,
    "platformFeeBps": 200,
    "feeRoundingMode": "UP",
    "policyRevisionId": "policy-revision-uuid",
    "policyRevision": 1
  }
}
~~~

Field meaning:

| Field | Meaning |
| --- | --- |
| blockingReasons | Conditions that prevent Publish |
| warnings | Non-blocking notices |
| canPublish | True only when there are no blocking reasons |
| questFundingTotal | Inclusive amount in Baht per slot |
| questFundingTotalSatang | Exact inclusive amount per slot |
| questReward | Worker amount in Baht per slot |
| questRewardSatang | Exact Worker amount per slot |
| platformFee | Fee in Baht per slot |
| platformFeeSatang | Exact fee per slot |
| escrowRequirement | Reserved amount in Baht for all slots |
| escrowRequirementSatang | Exact reserved amount for all slots |
| headcount | Number of slots |
| platformFeeBps | Fee rate in basis points |
| feeRoundingMode | Current value is UP |
| policyRevisionId | Fee policy snapshot identifier |
| policyRevision | Fee policy snapshot revision |

Known blocking codes:

- QUEST_HEADCOUNT_INVALID
- QUEST_TAG_REQUIRED
- QUEST_CONDITION_REQUIRED
- QUEST_DUE_AT_REQUIRED
- QUEST_DUE_AT_INVALID
- QUEST_DUE_AT_NOT_AFTER_START_TIME
- QUEST_START_TIME_NOT_IN_FUTURE
- WALLET_NOT_ACTIVE
- QUEST_ESCROW_AMOUNT_OUT_OF_RANGE
- INSUFFICIENT_SPENDING_BALANCE

Possible infrastructure error:

- 503 QUEST_ESCROW_UNAVAILABLE

Use canPublish and blockingReasons to control the Publish button.
The server checks all rules again during Publish.

### 5.8 Publish the Draft

Request:

~~~http
POST /api/v2/quests/:questId/publish
Idempotency-Key: publish-quest-client-action-id
~~~

There is no business body.
Only the owning Hirer can publish an owned QUEST_DRAFT.
Publish validates again and reserves exact escrow atomically.

Success status: HTTP 200.

~~~json
{
  "success": true,
  "data": {
    "quest": {
      "id": "quest-uuid",
      "version": 2,
      "state": "QUEST_OPEN"
    },
    "questEscrow": {
      "reservationId": "reservation-uuid",
      "questFundingTotal": 1000,
      "questFundingTotalSatang": 100000,
      "questReward": 980,
      "questRewardSatang": 98000,
      "platformFee": 20,
      "platformFeeSatang": 2000,
      "escrowRequirement": 1000,
      "escrowRequirementSatang": 100000,
      "headcount": 1,
      "platformFeeBps": 200,
      "feeRoundingMode": "UP",
      "policyRevisionId": "policy-revision-uuid",
      "policyRevision": 1
    }
  }
}
~~~

The example Quest is shortened.
The actual quest value is a complete CanonicalQuest.
Do not recalculate fee or escrow in the frontend.

Funding examples:

- 20.00 can produce 19.60 Quest Reward and 0.40 Platform Fee.
- 1.03 can produce 1.00 Quest Reward and 0.03 Platform Fee.
- Escrow requirement is inclusive Quest Funding Total multiplied by headcount.

Publish errors:

- 404 QUEST_NOT_FOUND
- 409 QUEST_NOT_DRAFT
- 409 with the first blocking publish reason
- 409 WALLET_NOT_ACTIVE
- 409 INSUFFICIENT_SPENDING_BALANCE
- 409 QUEST_ESCROW_AMOUNT_OUT_OF_RANGE
- idempotency errors
- 503 QUEST_ESCROW_UNAVAILABLE

After success, render Quest State QUEST_OPEN.

## 6. Quest Board and public detail

### 6.1 Read the Quest Board

Request:

~~~http
GET /api/v2/quests
~~~

Query fields:

| Query | Type | Meaning |
| --- | --- | --- |
| q | string | Text search |
| tagId | UUID | Filter by Tag |
| mode | enum | FIRST_COME_FIRST_SERVED or CANDIDATE |
| participation | enum | SINGLE or GROUP |
| minQuestReward | number | Minimum per-slot Quest Reward in Baht |
| maxQuestReward | number | Maximum per-slot Quest Reward in Baht |
| maxDurationMinutes | integer | Maximum duration |
| startFrom | date-time | Earliest start; Bangkok +07:00 |
| startTo | date-time | Latest start; Bangkok +07:00 |
| limit | integer | 1 to 50; default 20 |
| cursor | string | Opaque cursor |

Money query values accept at most two decimal digits.
startFrom must not be after startTo.

The Board returns visible, non-hidden, QUEST_OPEN v2 Quests that are
joinable for the current caller.
The current Hirer does not see their own Quest.
The Quest must have a future startTime.

Joinable rules:

- Candidate Quest: open before start; application or team rules apply.
- First-come SINGLE: activeWorkerCount is zero.
- First-come GROUP: activeWorkerCount is lower than headcount.

The result is sorted by startTime ascending and then id ascending.

Success status: HTTP 200.

~~~json
{
  "success": true,
  "data": {
    "items": [
      {
        "id": "quest-uuid",
        "title": "Design a landing page",
        "questReward": 980,
        "tag": {
          "id": "tag-uuid",
          "name": "Design"
        },
        "mode": "FIRST_COME_FIRST_SERVED",
        "participation": "SINGLE",
        "headcount": 1,
        "activeWorkerCount": 0,
        "startTime": "2026-09-30T09:00:00.000+07:00",
        "dueAt": "2026-10-07T18:00:00.000+07:00",
        "hirerName": "Hirer display name",
        "location": "Online"
      }
    ],
    "nextCursor": null
  }
}
~~~

Board Card fields:

| Field | Meaning |
| --- | --- |
| id | Quest identifier |
| title | Quest title |
| questReward | Per-slot Worker reward in Baht |
| tag | null or object with id and name |
| mode | Quest mode |
| participation | SINGLE or GROUP |
| headcount | Required slot count |
| activeWorkerCount | Current active Assignment count |
| startTime | Scheduled start |
| dueAt | Deadline or null |
| hirerName | Display name only |
| location | Display location or null |

Board Card does not include state, description, condition, images, Hirer ID,
Quest Funding Total, fee, escrow, wallet, or policy data.
Call public detail for full public Quest content.

### 6.2 Read public Quest detail

Request:

~~~http
GET /api/v2/quests/:questId/public
~~~

The caller must be authenticated and must not be the owning Hirer.
The Quest must be visible and in QUEST_OPEN.

Success status: HTTP 200.

~~~json
{
  "success": true,
  "data": {
    "id": "quest-uuid",
    "title": "Design a landing page",
    "description": "Create one responsive landing page.",
    "condition": {
      "items": [
        { "position": 0, "text": "Use the supplied brand colors" }
      ]
    },
    "tag": {
      "id": "tag-uuid",
      "name": "Design"
    },
    "mode": "FIRST_COME_FIRST_SERVED",
    "participation": "SINGLE",
    "state": "QUEST_OPEN",
    "questReward": 980,
    "headcount": 1,
    "activeWorkerCount": 0,
    "startTime": "2026-09-30T09:00:00.000+07:00",
    "dueAt": "2026-10-07T18:00:00.000+07:00",
    "proofRequired": true,
    "hirerName": "Hirer display name",
    "locations": [
      { "label": "Online" }
    ],
    "images": [
      {
        "imageId": "image-uuid",
        "position": 0,
        "url": "temporary-url",
        "urlExpiresAt": "2026-09-08T10:15:00.000+07:00"
      }
    ]
  }
}
~~~

Public detail does not expose fileId.
It exposes only temporary image URLs.

Error:

- 404 QUEST_NOT_FOUND for missing, hidden, not-open, or unreadable detail.

### 6.3 Read participation Quest detail

Request:

~~~http
GET /api/v2/quests/:questId/participation
~~~

The caller must be authenticated and must hold an Assignment on the Quest.
The caller must not be the owning Hirer.
This is the Worker lifecycle view that public detail is not: it stays readable
in every Quest State, including the terminal ones, and while the Quest is
hidden.

Success status: HTTP 200.

The data value carries every field of section 6.2 with the same meaning, plus
assignment and capabilities:

~~~json
{
  "success": true,
  "data": {
    "id": "quest-uuid",
    "title": "Design a landing page",
    "state": "QUEST_IN_PROGRESS",
    "questReward": 980,
    "headcount": 1,
    "activeWorkerCount": 1,
    "assignment": {
      "status": "ASSIGNMENT_ACTIVE",
      "startedAt": "2026-09-30T02:00:00.000Z"
    },
    "capabilities": {
      "canViewOnly": false
    }
  }
}
~~~

assignment.status is ASSIGNMENT_ACTIVE, ASSIGNMENT_COMPLETED,
ASSIGNMENT_INCOMPLETE, or ASSIGNMENT_CANCELLED.
Access rests on the Assignment row in any of those states, so the Member keeps
this view after settlement makes the Assignment terminal.
assignment.startedAt is null until automatic start sets it.
It is a UTC instant with a Z suffix. The +07:00 rule in section 2.5 covers
Quest schedule fields such as startTime and dueAt, not this one.

capabilities.canViewOnly is true in QUEST_COMPLETED, QUEST_CANCELLED, and
QUEST_FAILED. A terminal Quest is read-only, and the client must not offer a
command on it.

Quest Hide is discovery isolation only, so the hidden overlay does not take
this view away from a current Accepted Participant. The response never contains
the overlay itself, Quest Funding Total, Platform Fee, Money Policy, Wallet,
Funding Reservation, hirerId, Candidate data, or any Admin action.

Error:

- 404 QUEST_NOT_FOUND for a caller with no Assignment on the Quest, for the
  owning Hirer, for a v1 Quest, and for a missing Quest.

## 7. First-come Quest flow

Use this branch only when mode is FIRST_COME_FIRST_SERVED.

### 7.1 Join a Quest

Request:

~~~http
POST /api/v2/quests/:questId/join
Idempotency-Key: join-quest-client-action-id
~~~

There is no business body.
The caller must be a non-Hirer Prospective Worker.
The Quest must be visible, QUEST_OPEN, and before startTime.
The command creates Work Chat membership through the backend.

For SINGLE, the Quest becomes QUEST_ASSIGNED.
For GROUP, the Quest stays QUEST_OPEN until activeWorkerCount reaches
headcount.

Success status: HTTP 200.

~~~json
{
  "success": true,
  "data": {
    "id": "assignment-uuid",
    "questId": "quest-uuid",
    "workerId": "worker-uuid",
    "state": "ASSIGNMENT_ACTIVE",
    "questState": "QUEST_ASSIGNED",
    "startedAt": null,
    "createdAt": "2026-09-08T10:00:00.000+07:00"
  }
}
~~~

For an unfilled GROUP Quest, questState can be QUEST_OPEN.

Errors:

- 404 QUEST_NOT_FOUND
- 409 QUEST_MODE_NOT_ALLOWED
- 409 QUEST_PARTICIPATION_NOT_ALLOWED
- 409 HIRER_CANNOT_JOIN
- 409 QUEST_NOT_OPEN
- 409 QUEST_ROSTER_FROZEN
- 409 ASSIGNMENT_ALREADY_EXISTS
- 409 QUEST_FULL
- 503 WORK_CHAT_UNAVAILABLE
- idempotency errors

If the response is lost, retry with the same key.
Then read the Assignment list.

### 7.2 List my active Assignments

Request:

~~~http
GET /api/v2/assignments/mine
~~~

Success status: HTTP 200.

~~~json
{
  "success": true,
  "data": {
    "items": [
      {
        "id": "assignment-uuid",
        "questId": "quest-uuid",
        "workerId": "worker-uuid",
        "state": "ASSIGNMENT_ACTIVE",
        "questState": "QUEST_ASSIGNED",
        "startedAt": null,
        "createdAt": "2026-09-08T10:00:00.000+07:00"
      }
    ]
  }
}
~~~

This endpoint has no cursor or limit.
It returns active v2 Assignments for the authenticated Worker.

Assignment fields:

| Field | Meaning |
| --- | --- |
| id | Assignment identifier |
| questId | Quest identifier |
| workerId | Worker Member identifier |
| state | ASSIGNMENT_ACTIVE, ASSIGNMENT_COMPLETED, ASSIGNMENT_INCOMPLETE, or ASSIGNMENT_CANCELLED |
| questState | Current Quest State |
| startedAt | Automatic start time or null |
| createdAt | Assignment creation time |

### 7.3 List Quest Assignments

Request:

~~~http
GET /api/v2/quests/:questId/assignments
~~~

The owning Hirer receives all active Assignments.
The current active Worker receives only their own Assignment.
Other callers receive a masked 404 QUEST_NOT_FOUND.

Success response:

~~~json
{
  "success": true,
  "data": {
    "items": [
      {
        "id": "assignment-uuid",
        "questId": "quest-uuid",
        "workerId": "worker-uuid",
        "state": "ASSIGNMENT_ACTIVE",
        "questState": "QUEST_IN_PROGRESS",
        "startedAt": "2026-09-30T09:00:02.000+07:00",
        "createdAt": "2026-09-08T10:00:00.000+07:00"
      }
    ]
  }
}
~~~

## 8. Candidate SINGLE flow

Use this branch only when mode is CANDIDATE and participation is SINGLE.

### 8.1 Apply

Request:

~~~http
POST /api/v2/quests/:questId/applications
Idempotency-Key: apply-quest-client-action-id
~~~

There is no business body.
The caller must be a non-Hirer Candidate.
The Quest must be open, visible, and before startTime.

Success status: HTTP 200.

~~~json
{
  "success": true,
  "data": {
    "id": "application-uuid",
    "questId": "quest-uuid",
    "memberId": "candidate-uuid",
    "state": "APPLICATION_APPLIED",
    "appliedAt": "2026-09-08T10:00:00.000+07:00"
  }
}
~~~

Application fields:

| Field | Meaning |
| --- | --- |
| id | Application identifier |
| questId | Quest identifier |
| memberId | Candidate Member identifier |
| state | APPLICATION_APPLIED, APPLICATION_SELECTED, APPLICATION_REJECTED, or APPLICATION_WITHDRAWN |
| appliedAt | Application time |

Errors:

- 404 QUEST_NOT_FOUND
- 409 QUEST_MODE_NOT_ALLOWED
- 409 QUEST_PARTICIPATION_NOT_ALLOWED
- 409 HIRER_CANNOT_APPLY
- 409 QUEST_NOT_OPEN
- 409 APPLICATION_ALREADY_EXISTS
- idempotency errors

### 8.2 List applications

Request:

~~~http
GET /api/v2/quests/:questId/applications
~~~

The owning Hirer sees all applications.
The Candidate sees only their own application.
The endpoint is readable while the Quest is QUEST_OPEN or QUEST_ASSIGNED.
Other callers receive a masked 404 QUEST_NOT_FOUND.

Success status: HTTP 200.

~~~json
{
  "success": true,
  "data": {
    "items": [
      {
        "id": "application-uuid",
        "questId": "quest-uuid",
        "memberId": "candidate-uuid",
        "state": "APPLICATION_APPLIED",
        "appliedAt": "2026-09-08T10:00:00.000+07:00"
      }
    ]
  }
}
~~~

This endpoint has no pagination.

### 8.3 Read one application

Request:

~~~http
GET /api/v2/quests/:questId/applications/:applicationId
~~~

The same role and state rules as the list endpoint apply.
The data value is one Application object.

### 8.4 Withdraw an application

Request:

~~~http
POST /api/v2/quests/:questId/applications/:applicationId/withdraw
Idempotency-Key: withdraw-application-client-action-id
~~~

There is no business body.
Only the application owner can withdraw while the Quest is open and before
selection.

Success status: HTTP 200.
The data value is the Application with state APPLICATION_WITHDRAWN.

Errors:

- 404 APPLICATION_NOT_FOUND
- 409 APPLICATION_NOT_WITHDRAWABLE
- 409 HIRER_CANNOT_WITHDRAW
- idempotency errors

### 8.5 Select an application

Request:

~~~http
POST /api/v2/quests/:questId/applications/:applicationId/select
Idempotency-Key: select-application-client-action-id
~~~

There is no business body.
Only the owning Hirer can select.
The Quest must be QUEST_OPEN and before startTime.

The command atomically:

1. marks the selected application APPLICATION_SELECTED;
2. rejects other applications;
3. creates the Assignment;
4. changes the Quest to QUEST_ASSIGNED;
5. creates Work Chat membership.

Success status: HTTP 200.

~~~json
{
  "success": true,
  "data": {
    "assignments": [
      {
        "id": "assignment-uuid",
        "questId": "quest-uuid",
        "workerId": "candidate-uuid",
        "state": "ASSIGNMENT_ACTIVE",
        "questState": "QUEST_ASSIGNED",
        "startedAt": null,
        "createdAt": "2026-09-08T10:00:00.000+07:00"
      }
    ],
    "questState": "QUEST_ASSIGNED"
  }
}
~~~

Errors:

- 404 QUEST_NOT_FOUND
- 404 APPLICATION_NOT_FOUND
- 409 CANDIDATE_SELECTION_NOT_ALLOWED
- 409 CANDIDATE_NOT_SELECTABLE
- 409 ASSIGNMENT_ALREADY_EXISTS
- 503 WORK_CHAT_UNAVAILABLE
- idempotency errors

## 9. Candidate GROUP flow: Candidate Teams

Use this branch only when mode is CANDIDATE and participation is GROUP.

A Candidate Team is a team of Prospective Workers.
The Team Leader creates and submits it.
The Hirer selects one submitted Team.

### 9.1 Team response shape

~~~json
{
  "id": "team-uuid",
  "questId": "quest-uuid",
  "leaderId": "leader-uuid",
  "name": "Frontend team",
  "headcount": 3,
  "state": "TEAM_FORMING",
  "joinCode": "ABCD2345",
  "joinCodeExpiresAt": "2026-09-09T10:00:00.000+07:00",
  "members": [
    {
      "memberId": "leader-uuid",
      "joinedAt": "2026-09-08T10:00:00.000+07:00"
    }
  ],
  "submission": null,
  "createdAt": "2026-09-08T10:00:00.000+07:00"
}
~~~

Team fields:

| Field | Meaning |
| --- | --- |
| id | Team identifier |
| questId | Quest identifier |
| leaderId | Current Team Leader |
| name | Team name |
| headcount | Required team size |
| state | TEAM_FORMING, TEAM_SUBMITTED, TEAM_SELECTED, TEAM_REJECTED, or TEAM_DISBANDED |
| joinCode | Plaintext code only when a new code is created; reads can return null |
| joinCodeExpiresAt | Code expiry time |
| members | Members with memberId and joinedAt |
| submission | Submission object or null |
| createdAt | Team creation time |

Join codes use eight characters from ABCDEFGHJKLMNPQRSTUVWXYZ23456789.
Input is trimmed and uppercased.
The plaintext code is returned when a Team is created or a code is regenerated.
The code becomes null after submission.

### 9.2 Create a Candidate Team

Request:

~~~http
POST /api/v2/quests/:questId/teams
Idempotency-Key: create-team-client-action-id
Content-Type: application/json
~~~

~~~json
{
  "name": "Frontend team",
  "headcount": 3
}
~~~

Fields:

| Field | Type | Rule |
| --- | --- | --- |
| name | string | Non-blank team name |
| headcount | integer | At least 2 and no more than Quest headcount |

The caller becomes Team Leader and first member.
The Quest must be open and before startTime.

Success status: HTTP 201.
The data value is the complete Team object.

Errors:

- 404 QUEST_NOT_FOUND
- 409 QUEST_MODE_NOT_ALLOWED
- 409 QUEST_PARTICIPATION_NOT_ALLOWED
- 409 HIRER_CANNOT_JOIN_TEAM
- 409 QUEST_NOT_OPEN
- 409 TEAM_HEADCOUNT_NOT_ALLOWED
- idempotency errors

### 9.3 List Candidate Teams

Request:

~~~http
GET /api/v2/quests/:questId/teams
~~~

The Quest must be QUEST_OPEN.
The Hirer sees all non-disbanded Teams.
A Team member sees their own Team.
This endpoint is not a Team history endpoint after assignment.

Success status: HTTP 200.
The data value is an object with items, where each item is a complete Team.

~~~json
{
  "success": true,
  "data": {
    "items": [
      {
        "id": "team-uuid",
        "questId": "quest-uuid",
        "leaderId": "leader-uuid",
        "name": "Frontend team",
        "headcount": 3,
        "state": "TEAM_FORMING",
        "joinCode": null,
        "joinCodeExpiresAt": null,
        "members": [],
        "submission": null,
        "createdAt": "2026-09-08T10:00:00.000+07:00"
      }
    ]
  }
}
~~~

### 9.4 Read a Candidate Team

Request:

~~~http
GET /api/v2/quests/:questId/teams/:teamId
~~~

The same visibility rules as the list endpoint apply.
The data value is one complete Team object.

### 9.5 Update the Team name

Request:

~~~http
PATCH /api/v2/quests/:questId/teams/:teamId
Idempotency-Key: update-team-client-action-id
Content-Type: application/json
~~~

~~~json
{ "name": "New team name" }
~~~

Only the Team Leader can update a TEAM_FORMING Team while the Quest is open.
Success status: HTTP 200.
The data value is the complete Team object.

### 9.6 Join a Candidate Team

Request:

~~~http
POST /api/v2/quests/:questId/teams/:teamId/join
Idempotency-Key: join-team-client-action-id
Content-Type: application/json
~~~

~~~json
{ "joinCode": "abcd2345" }
~~~

The server normalizes the code to uppercase.
The caller must be a Prospective Worker.
The Team must be forming, open, not full, and before startTime.

Success status: HTTP 200.
The data value is the complete Team object.

Errors:

- 404 TEAM_NOT_FOUND
- 409 TEAM_MEMBERSHIP_ALREADY_EXISTS
- 409 TEAM_FULL
- 409 TEAM_NOT_FORMING
- 409 JOIN_CODE_INVALID
- 409 JOIN_CODE_EXPIRED
- 409 HIRER_CANNOT_JOIN_TEAM
- 409 QUEST_NOT_OPEN
- idempotency errors

### 9.7 Leave a Candidate Team

Request:

~~~http
POST /api/v2/quests/:questId/teams/:teamId/leave
Idempotency-Key: leave-team-client-action-id
~~~

There is no business body.
The caller must be a Team member.
The Team must be forming and the Quest must be open.
If the Team Leader leaves, leadership transfers when possible.
If the last member leaves, the Team is disbanded.

Success status: HTTP 200.
The data value is the complete Team object.

### 9.8 Remove a Team member

Request:

~~~http
DELETE /api/v2/quests/:questId/teams/:teamId/members/:memberId
Idempotency-Key: remove-team-member-client-action-id
~~~

There is no business body.
Only the Team Leader can remove another member.
The Team Leader cannot remove themself.
The Team must be forming and the Quest must be open.

Success status: HTTP 200.
The data value is the complete Team object.

Errors:

- 404 TEAM_NOT_FOUND
- 404 TEAM_MEMBER_NOT_FOUND
- 409 TEAM_LEADER_REQUIRED
- 409 TEAM_LEADER_CANNOT_REMOVE_SELF
- 409 TEAM_NOT_FORMING
- idempotency errors

### 9.9 Regenerate a Team join code

Request:

~~~http
POST /api/v2/quests/:questId/teams/:teamId/join-code
Idempotency-Key: regenerate-team-code-client-action-id
~~~

Only the Team Leader can regenerate a code for a forming Team.
The Quest must be open.

Success status: HTTP 200.
The data value is the complete Team object and includes the new plaintext
joinCode and joinCodeExpiresAt.

### 9.10 Submit a Candidate Team

Request:

~~~http
POST /api/v2/quests/:questId/teams/:teamId/submit
Idempotency-Key: submit-team-client-action-id
Content-Type: application/json
~~~

~~~json
{
  "text": "We will complete the Quest as a three-person team.",
  "fileIds": [
    "private-file-uuid"
  ]
}
~~~

Fields:

| Field | Type | Required | Rule |
| --- | --- | --- | --- |
| text | string | yes | Non-blank submission text |
| fileIds | UUID array | yes | Files owned by Team Leader; allowed image, PDF, and video types; total maximum 10 MB |

The Team Leader can submit only when the Team is full.
Submission changes the Team to TEAM_SUBMITTED.
The submission is immutable.

Submission response:

~~~json
{
  "text": "We will complete the Quest as a three-person team.",
  "fileIds": ["private-file-uuid"],
  "submittedAt": "2026-09-08T10:00:00.000+07:00"
}
~~~

Important file identifier gap:

- This endpoint requires private File IDs.
- Work Chat upload returns a Chat Attachment ID.
- A Chat Attachment ID is not a private File ID.
- The current v2 contract has no generic frontend file upload route that
  returns the required private File ID.

Do not send a Chat Attachment ID as fileIds.
Do not guess an ID conversion.
If this blocks the UI, report the missing backend contract.

Errors:

- 409 TEAM_HEADCOUNT_MISMATCH
- 409 TEAM_SUBMISSION_INVALID
- 409 TEAM_SUBMISSION_FILES_INVALID
- 409 TEAM_NOT_FORMING
- idempotency errors

### 9.11 Select a Candidate Team

Request:

~~~http
POST /api/v2/quests/:questId/teams/:teamId/select
Idempotency-Key: select-team-client-action-id
~~~

There is no business body.
Only the owning Hirer can select a submitted full Team.

The command atomically:

1. changes the selected Team to TEAM_SELECTED;
2. rejects other submitted Teams;
3. creates one active Assignment for each Team member;
4. changes the Quest to QUEST_ASSIGNED;
5. creates Work Chat membership for all accepted Workers.

Success status: HTTP 200.

~~~json
{
  "success": true,
  "data": {
    "questState": "QUEST_ASSIGNED",
    "assignments": [
      {
        "id": "assignment-uuid",
        "questId": "quest-uuid",
        "workerId": "member-uuid",
        "state": "ASSIGNMENT_ACTIVE",
        "questState": "QUEST_ASSIGNED",
        "startedAt": null,
        "createdAt": "2026-09-08T10:00:00.000+07:00"
      }
    ]
  }
}
~~~

Errors:

- 404 QUEST_NOT_FOUND
- 404 TEAM_NOT_FOUND
- 409 CANDIDATE_SELECTION_NOT_ALLOWED
- 409 CANDIDATE_TEAM_NOT_SELECTABLE
- 409 ASSIGNMENT_ALREADY_EXISTS
- 503 WORK_CHAT_UNAVAILABLE
- idempotency errors

## 10. Automatic start and Work Chat

### 10.1 Automatic start

After an Assignment is created:

1. Render QUEST_ASSIGNED before startTime.
2. Refresh after the scheduled start.
3. Enable work and Proof Submission UI after QUEST_IN_PROGRESS.
4. Handle a delayed worker transition without showing a false failure.
5. Check for a pending Quest Edit before assuming that the Quest can start.

There is no client Start Work command.

### 10.2 Work Chat

Quest v2 does not expose Work Chat routes under /api/v2.
Work Chat is under the existing /api/v1/chat/conversations API.
Quest v2 commands create or update Work Chat membership at the Assignment
boundary.

Use Work Chat only after an active Assignment exists.
Do not grant membership from the frontend.
Do not use Candidate Inquiry Conversation as Work Chat.

Main Work Chat endpoints:

~~~text
GET    /api/v1/chat/conversations
GET    /api/v1/chat/conversations/:conversationId/participants
POST   /api/v1/chat/conversations/:conversationId/attachments
GET    /api/v1/chat/conversations/:conversationId/attachments/:attachmentId/link
DELETE /api/v1/chat/conversations/:conversationId/attachments/:attachmentId
GET    /api/v1/chat/conversations/:conversationId/messages
POST   /api/v1/chat/conversations/:conversationId/messages
POST   /api/v1/chat/conversations/:conversationId/read
WS     /api/v1/chat/conversations/:conversationId/events
~~~

REST is authoritative.
Use WebSocket messages as updates, then refresh from REST when exact state is
needed.

Work Chat summary:

~~~json
{
  "id": "conversation-uuid",
  "type": "CONVERSATION_WORK",
  "quest": {
    "id": "quest-uuid",
    "title": "Design a landing page",
    "status": "QUEST_IN_PROGRESS"
  },
  "latestMessage": {
    "id": "message-uuid",
    "kind": "USER",
    "preview": "I submitted the work.",
    "createdAt": "2026-09-30T10:00:00.000+07:00"
  },
  "lastActivityAt": "2026-09-30T10:00:00.000+07:00",
  "archived": false,
  "readOnly": false,
  "unreadCount": 0
}
~~~

Work Chat message body:

~~~json
{
  "clientMessageId": "client-generated-unique-id",
  "text": "I will submit the work soon.",
  "attachmentIds": ["attachment-uuid"]
}
~~~

text and attachmentIds are optional, but the message must have usable content.
An attachment ID is valid for Chat messages only.
It is not the private fileId required by Candidate Team submission.

### 10.3 Quest Edit after assignment

A Hirer can propose a Condition change only while the Quest is
QUEST_ASSIGNED and there is at least one active Worker.
A pending Quest Edit blocks automatic start.

Create request:

~~~http
POST /api/v2/quests/:questId/edit-requests
Idempotency-Key: create-edit-request-client-action-id
Content-Type: application/json
~~~

~~~json
{
  "condition": {
    "items": [
      "Use the new brand colors",
      "Include a mobile layout"
    ]
  }
}
~~~

The body replaces the complete Condition list.
Each item is 1 to 255 non-blank characters.
Only one pending request can exist.
The request expires after 10 minutes.

Success status: HTTP 201.

~~~json
{
  "success": true,
  "data": {
    "requestId": "edit-request-uuid",
    "questId": "quest-uuid",
    "status": "EDIT_REQUEST_PENDING",
    "failureCode": null,
    "createdAt": "2026-09-30T08:00:00.000+07:00",
    "expiresAt": "2026-09-30T08:10:00.000+07:00",
    "appliedAt": null,
    "failedAt": null,
    "previousCondition": {
      "items": [
        { "position": 0, "text": "Old condition" }
      ]
    },
    "proposedCondition": {
      "items": [
        { "position": 0, "text": "Use the new brand colors" },
        { "position": 1, "text": "Include a mobile layout" }
      ]
    },
    "responseSummary": {
      "totalCount": 1,
      "acceptedCount": 0,
      "declinedCount": 0,
      "pendingCount": 1
    },
    "responses": [],
    "ownResponse": null
  }
}
~~~

Hirer view includes responses.
Active Worker view includes ownResponse and responseSummary.
Candidate, Prospective Worker, and departed Worker cannot read it.

Read request:

~~~http
GET /api/v2/quests/edit-requests/:requestId
~~~

Only the Hirer or a current active Worker can read it.
The data value has the same Quest Edit Request shape.

Worker response:

~~~http
POST /api/v2/quests/edit-requests/:requestId/respond
Idempotency-Key: respond-edit-request-client-action-id
Content-Type: application/json
~~~

Accept:

~~~json
{ "decision": "EDIT_RESPONSE_ACCEPTED" }
~~~

Decline:

~~~json
{
  "decision": "EDIT_RESPONSE_DECLINED",
  "reason": "The new condition is not feasible before the deadline."
}
~~~

reason is allowed only for a decline and is at most 255 characters.
A Worker can respond once.
All active Workers accepting applies the proposed Condition.
Any decline, timeout, or active Worker departure fails the request.
The old Condition remains when the request fails.

Errors:

- 404 QUEST_EDIT_NOT_FOUND
- 409 QUEST_EDIT_NOT_ALLOWED
- 409 QUEST_EDIT_PENDING
- 409 QUEST_EDIT_NO_ACTIVE_WORKERS
- 409 QUEST_EDIT_NO_CHANGE
- 409 QUEST_EDIT_NOT_PENDING
- 409 QUEST_EDIT_ALREADY_RESPONDED
- 409 QUEST_EDIT_EXPIRED
- validation and idempotency errors

## 11. GROUP first-come underfilled flow

Use this branch only when:

~~~text
mode = FIRST_COME_FIRST_SERVED
participation = GROUP
activeWorkerCount < headcount at startTime
~~~

At the scheduled start, the backend can create an Underfilled decision.
The frontend does not create this object.

### 11.1 Read Underfilled status

Request:

~~~http
GET /api/v2/quests/:questId/underfilled
~~~

The Hirer sees decision and all Worker responses.
An active Worker sees the decision and ownResponse.
Other callers receive 404 QUEST_UNDERFILLED_NOT_FOUND.

Response:

~~~json
{
  "success": true,
  "data": {
    "id": "underfilled-uuid",
    "questId": "quest-uuid",
    "questState": "QUEST_IN_PROGRESS",
    "state": "UNDERFILLED_DECISION_PENDING",
    "activeWorkerCount": 1,
    "headcount": 3,
    "workerRewardPool": 1960,
    "questReward": null,
    "dueAt": "2026-10-07T18:00:00.000+07:00",
    "decision": {
      "status": "UNDERFILLED_DECISION_PENDING",
      "value": null,
      "expiresAt": "2026-09-30T09:10:00.000+07:00"
    },
    "consent": {
      "status": "UNDERFILLED_CONSENT_NOT_STARTED",
      "expiresAt": null,
      "totalCount": 0,
      "acceptedCount": 0,
      "declinedCount": 0,
      "pendingCount": 0
    },
    "responses": [],
    "ownResponse": null
  }
}
~~~

Underfilled fields:

| Field | Meaning |
| --- | --- |
| id | Underfilled process identifier |
| questId | Quest identifier |
| questState | Current Quest State |
| state | UNDERFILLED_DECISION_PENDING, UNDERFILLED_CONSENT_PENDING, UNDERFILLED_COMPLETED, or UNDERFILLED_CANCELLED |
| activeWorkerCount | Number of active Workers |
| headcount | Required slot count |
| workerRewardPool | Hirer-facing Worker pool or null |
| questReward | Worker-facing reward or null |
| dueAt | Quest deadline or null |
| decision | Hirer decision status, value, and expiry |
| consent | Worker consent status, expiry, and counts |
| responses | Hirer-facing response list |
| ownResponse | Worker-facing response |

Decision response items:

~~~json
{
  "workerId": "worker-uuid",
  "assignmentId": "assignment-uuid",
  "decision": "ACCEPT",
  "questReward": 1960,
  "respondedAt": "2026-09-30T09:05:00.000+07:00"
}
~~~

The Hirer can see workerRewardPool and responses.
The Worker can see questReward and ownResponse.

### 11.2 Hirer decision

Request:

~~~http
POST /api/v2/quests/:questId/underfilled/decision
Idempotency-Key: underfilled-decision-client-action-id
Content-Type: application/json
~~~

Proceed:

~~~json
{ "decision": "PROCEED" }
~~~

Cancel:

~~~json
{ "decision": "CANCEL" }
~~~

Only the Hirer can call this command.
The decision window is time limited.
PROCEED starts Worker consent.
CANCEL cancels the Quest and settles the applicable money outcome.
The success data value is the complete Underfilled object.

Errors:

- 404 QUEST_UNDERFILLED_NOT_FOUND
- 409 QUEST_NOT_UNDERFILLED
- 409 QUEST_UNDERFILLED_NOT_PENDING
- 409 QUEST_UNDERFILLED_EXPIRED
- idempotency errors

### 11.3 Worker consent

Request:

~~~http
POST /api/v2/quests/:questId/underfilled/consent
Idempotency-Key: underfilled-consent-client-action-id
Content-Type: application/json
~~~

Accept:

~~~json
{ "decision": "ACCEPT" }
~~~

Decline:

~~~json
{ "decision": "DECLINE" }
~~~

Only an active Worker can call this command.
Each Worker responds once.
All active Workers accepting changes the Quest to QUEST_ASSIGNED with the
underfilled reward split.
Any decline or expiry cancels the Quest.
The success data value is the complete Underfilled object.

Errors:

- 404 QUEST_UNDERFILLED_NOT_FOUND
- 409 QUEST_NOT_UNDERFILLED
- 409 QUEST_UNDERFILLED_NOT_PENDING
- 409 QUEST_UNDERFILLED_EXPIRED
- 409 QUEST_UNDERFILLED_ALREADY_RESPONDED
- 503 WORK_CHAT_UNAVAILABLE
- idempotency errors

## 12. Proof Submission flow

Use this branch only when the Quest is QUEST_IN_PROGRESS.
The active Worker is the Proof submitter.
The Hirer reviews the Proof.

### 12.1 Proof response shape

~~~json
{
  "id": "proof-uuid",
  "questId": "quest-uuid",
  "workerId": "worker-uuid",
  "teamId": null,
  "submittedByUserId": "member-uuid",
  "description": "Completed the landing page.",
  "status": "PROOF_PENDING",
  "submittedAt": "2026-10-01T10:00:00.000+07:00",
  "createdAt": "2026-10-01T09:00:00.000+07:00",
  "updatedAt": "2026-10-01T10:00:00.000+07:00",
  "visibility": "FULL",
  "fileIds": ["private-file-uuid"],
  "files": [
    {
      "fileId": "private-file-uuid",
      "contentType": "application/pdf",
      "sizeBytes": 12345,
      "position": 0,
      "uploadStatus": "PROOF_FILE_READY",
      "failureCode": null
    }
  ]
}
~~~

Proof status values:

- Draft: status null and submittedAt null.
- Submitted and awaiting review: PROOF_PENDING.
- Approved: PROOF_APPROVED.
- Not approved: PROOF_NOT_APPROVED.

visibility is FULL for the submitter and Hirer.
Other permitted viewers can receive SUMMARY.

### 12.2 Create a Proof Draft

JSON request:

~~~http
POST /api/v2/quests/:questId/proof-submissions
Idempotency-Key: create-proof-client-action-id
Content-Type: application/json
~~~

~~~json
{
  "description": "Completed the landing page.",
  "fileIds": [
    "private-file-uuid"
  ]
}
~~~

Multipart request:

~~~http
POST /api/v2/quests/:questId/proof-submissions
Idempotency-Key: create-proof-client-action-id
Content-Type: multipart/form-data
~~~

Multipart fields:

- description: optional text, maximum 1000 characters;
- files: up to five uploaded files;
- fileIds: private file IDs when using existing files;
- retryPosition: not allowed on create.

Do not send fileIds and files in the same request.
The Draft must contain a description or at least one file.
The active Worker can have one Draft Proof for the Quest.
The request must be before dueAt.

The data value is a Proof object with null status.

Errors include:

- 404 QUEST_NOT_FOUND
- 409 QUEST_NOT_IN_PROGRESS
- 409 PROOF_ALREADY_EXISTS
- 409 PROOF_NOT_ALLOWED
- 409 PROOF_DEADLINE_PASSED
- 400 PROOF_CONTENT_REQUIRED
- file validation and upload errors
- idempotency errors

### 12.3 Edit a Proof Draft

Request:

~~~http
PATCH /api/v2/quests/:questId/proof-submissions/:proofSubmissionId
Idempotency-Key: edit-proof-client-action-id
Content-Type: application/json
~~~

~~~json
{
  "description": "Updated description.",
  "fileIds": [
    "private-file-uuid"
  ]
}
~~~

The body must contain at least one property.
description is a partial value.
fileIds replaces the complete file list.

For a failed upload slot, use multipart with exactly one new file and
retryPosition equal to the failed zero-based slot.
Do not combine retryPosition with fileIds.

Only the owner can edit an unsent Draft before dueAt.
Submitted Proof is locked.
The data value is the updated Proof object.

### 12.4 Delete a Proof Draft

Request:

~~~http
DELETE /api/v2/quests/:questId/proof-submissions/:proofSubmissionId
Idempotency-Key: delete-proof-client-action-id
~~~

Only the owner can delete an unsent Draft.
There is no business body.
Success status: HTTP 200.

~~~json
{
  "success": true,
  "data": {
    "deleted": true,
    "proofSubmissionId": "proof-uuid"
  }
}
~~~

### 12.5 Submit a Proof Draft

Request:

~~~http
POST /api/v2/quests/:questId/proof-submissions/:proofSubmissionId/submit
Idempotency-Key: submit-proof-client-action-id
~~~

There is no business body.
The Draft must have at least one ready file and no failed file slot.
The submitter must be an active Worker before dueAt.

Success data is the locked Proof:

~~~json
{
  "status": "PROOF_PENDING",
  "submittedAt": "2026-10-01T10:00:00.000+07:00"
}
~~~

### 12.6 List Proof Submissions

Request:

~~~http
GET /api/v2/quests/:questId/proof-submissions
~~~

Visibility:

- Hirer: all relevant Proof Submissions with FULL visibility.
- Worker: their own Proof Submission with FULL visibility.
- Other permitted participants: role-appropriate SUMMARY visibility.

Success status: HTTP 200.

~~~json
{
  "success": true,
  "data": {
    "items": [
      {
        "id": "proof-uuid",
        "questId": "quest-uuid",
        "workerId": "worker-uuid",
        "teamId": null,
        "submittedByUserId": "member-uuid",
        "description": "Completed the landing page.",
        "status": "PROOF_PENDING",
        "submittedAt": "2026-10-01T10:00:00.000+07:00",
        "createdAt": "2026-10-01T09:00:00.000+07:00",
        "updatedAt": "2026-10-01T10:00:00.000+07:00",
        "visibility": "FULL",
        "fileIds": [],
        "files": []
      }
    ]
  }
}
~~~

### 12.7 Review a Proof

Request:

~~~http
POST /api/v2/quests/:questId/proof-submissions/:proofSubmissionId/review
Idempotency-Key: review-proof-client-action-id
Content-Type: application/json
~~~

Approve:

~~~json
{ "decision": "PROOF_APPROVED" }
~~~

Do not approve:

~~~json
{
  "decision": "PROOF_NOT_APPROVED",
  "reason": "The mobile layout is missing."
}
~~~

Only the owning Hirer can review.
The first final review wins.
reason is required for PROOF_NOT_APPROVED.
reason is invalid for PROOF_APPROVED.

Success status: HTTP 200.

~~~json
{
  "success": true,
  "data": {
    "proof": {
      "id": "proof-uuid",
      "status": "PROOF_APPROVED"
    },
    "questStatus": "QUEST_COMPLETED"
  }
}
~~~

Approval settles the relevant money and can complete the Quest.
Non-approval changes the Quest to QUEST_FAILED and creates the relevant admin
review item.
The system can auto-approve a pending Proof after 24 hours.

Errors include:

- 404 QUEST_NOT_FOUND
- 404 PROOF_NOT_FOUND
- 409 PROOF_NOT_REVIEWABLE
- 409 PROOF_ALREADY_REVIEWED
- 409 PROOF_REVIEW_INVALID
- 409 QUEST_NOT_IN_PROGRESS
- idempotency errors

### 12.8 Confirm completion when proof is not required

Use this command only when proofRequired is false.

Request:

~~~http
POST /api/v2/quests/:questId/completion-confirmation
Idempotency-Key: confirm-completion-client-action-id
~~~

There is no business body.
Only the required accepted Worker can confirm.

Success status: HTTP 200.

~~~json
{
  "success": true,
  "data": {
    "confirmed": true,
    "confirmedAt": "2026-10-07T17:00:00.000+07:00",
    "questStatus": "QUEST_COMPLETED"
  }
}
~~~

For a GROUP Quest, the Quest can remain QUEST_IN_PROGRESS until all required
Accepted Participants complete their obligation.

Errors include:

- 404 QUEST_NOT_FOUND
- 409 QUEST_NOT_IN_PROGRESS
- 409 PROOF_REQUIRED
- 409 COMPLETION_ALREADY_CONFIRMED
- 409 COMPLETION_NOT_ALLOWED
- idempotency errors

## 13. Cancellation and money outcomes

### 13.1 Cancel a Quest

Request:

~~~http
POST /api/v2/quests/:questId/cancel
Idempotency-Key: cancel-quest-client-action-id
~~~

There is no business body.
Only the owning Hirer can cancel.
Allowed Quest States:

- QUEST_DRAFT
- QUEST_OPEN
- QUEST_ASSIGNED
- QUEST_IN_PROGRESS

Success status: HTTP 200.

~~~json
{
  "success": true,
  "data": {
    "questStatus": "QUEST_CANCELLED",
    "outcome": "CANCELLED",
    "paidSatang": 0,
    "refundedSatang": 100000
  }
}
~~~

Settlement meaning:

| State before cancel | Money outcome |
| --- | --- |
| QUEST_DRAFT | No payment and no refund |
| QUEST_OPEN | Refund 100 percent of reserved funding |
| QUEST_ASSIGNED | Pay 20 percent of Worker pool; refund remaining 80 percent and fee |
| QUEST_IN_PROGRESS | Full applicable settlement |

The returned paidSatang and refundedSatang values are authoritative.
Do not calculate them in the frontend.

Errors:

- 404 QUEST_NOT_FOUND
- 403 QUEST_NOT_AUTHORIZED
- 409 QUEST_SETTLEMENT_NOT_ALLOWED
- money domain errors with HTTP 409
- 503 WORK_CHAT_UNAVAILABLE
- idempotency errors

## 14. Rating Review flow

Rating Review is allowed after:

~~~text
QUEST_COMPLETED
QUEST_FAILED
QUEST_CANCELLED
~~~

Review does not change Quest State, Assignment state, Work Chat, or money.
The review window is seven days.
Each direction has one review:

- Hirer reviews Worker.
- Worker reviews Hirer.

### 14.1 Create a Rating Review

Request:

~~~http
POST /api/v2/quests/:questId/reviews
Idempotency-Key: create-review-client-action-id
Content-Type: application/json
~~~

Hirer body:

~~~json
{
  "revieweeId": "worker-uuid",
  "rating": 5,
  "comment": "Clear requirements and fast feedback."
}
~~~

Worker body:

~~~json
{
  "rating": 5,
  "comment": "The Quest had clear conditions."
}
~~~

Fields:

| Field | Type | Rule |
| --- | --- | --- |
| revieweeId | UUID | Required for Hirer; Worker must omit |
| rating | integer | 1 to 5 |
| comment | string | Optional; 1 to 1000 chars when supplied; not blank |

Success status: HTTP 200.

~~~json
{
  "success": true,
  "data": {
    "id": "review-uuid",
    "questId": "quest-uuid",
    "reviewerId": "member-uuid",
    "revieweeId": "other-member-uuid",
    "rating": 5,
    "comment": "Clear requirements and fast feedback.",
    "createdAt": "2026-10-08T10:00:00.000+07:00",
    "updatedAt": "2026-10-08T10:00:00.000+07:00"
  }
}
~~~

Errors:

- 404 QUEST_NOT_FOUND
- 409 QUEST_NOT_TERMINAL
- 409 REVIEW_NOT_ALLOWED
- 400 REVIEWEE_REQUIRED
- 400 INVALID_RATING
- 400 INVALID_COMMENT
- 409 REVIEW_ALREADY_EXISTS
- 409 REVIEW_WINDOW_EXPIRED
- idempotency errors

### 14.2 Edit a Rating Review

Request:

~~~http
PATCH /api/v2/quests/:questId/reviews/:reviewId
Idempotency-Key: edit-review-client-action-id
Content-Type: application/json
~~~

~~~json
{
  "rating": 4,
  "comment": "Updated comment."
}
~~~

At least one field is required.
Only the review author can edit within seven days.
Null is not valid for rating or comment.
The data value is the complete Rating Review.

Errors:

- 404 REVIEW_NOT_FOUND
- 409 REVIEW_CONFLICT
- 409 REVIEW_WINDOW_EXPIRED
- 400 INVALID_RATING
- 400 INVALID_COMMENT
- idempotency errors

## 15. Candidate Inquiry Conversation

Candidate Inquiry Conversation is not Work Chat.
It is for a Prospective Worker and Hirer before Assignment.
It does not grant Work Chat membership.

Routes are under /api/v1/chat/candidate-inquiries:

~~~text
POST   /api/v1/chat/candidate-inquiries
GET    /api/v1/chat/candidate-inquiries
GET    /api/v1/chat/candidate-inquiries/:conversationId
GET    /api/v1/chat/candidate-inquiries/:conversationId/participants
POST   /api/v1/chat/candidate-inquiries/:conversationId/attachments
GET    /api/v1/chat/candidate-inquiries/:conversationId/attachments/:attachmentId/link
DELETE /api/v1/chat/candidate-inquiries/:conversationId/attachments/:attachmentId
GET    /api/v1/chat/candidate-inquiries/:conversationId/messages
POST   /api/v1/chat/candidate-inquiries/:conversationId/messages
POST   /api/v1/chat/candidate-inquiries/:conversationId/read
WS     /api/v1/chat/candidate-inquiries/:conversationId/events
~~~

Create body:

~~~json
{ "questId": "quest-uuid" }
~~~

Use this conversation only before assignment while the Candidate opportunity
is open.
After assignment, use Work Chat.

## 16. Canonical response types

### 16.1 CanonicalQuest

~~~json
{
  "id": "quest-uuid",
  "version": 1,
  "hiddenAt": null,
  "title": "Quest title",
  "description": "Quest description or null",
  "condition": {
    "items": [
      {
        "position": 0,
        "text": "Condition Item text"
      }
    ]
  },
  "tag": {
    "id": "tag-uuid",
    "name": "Tag name"
  },
  "mode": "FIRST_COME_FIRST_SERVED",
  "participation": "SINGLE",
  "state": "QUEST_DRAFT",
  "questFundingTotal": 1000,
  "headcount": 1,
  "startTime": "2026-09-30T09:00:00.000+07:00",
  "dueAt": "2026-10-07T18:00:00.000+07:00",
  "proofRequired": true,
  "locations": [
    { "label": "Online" }
  ],
  "createdAt": "2026-09-08T10:00:00.000+07:00",
  "updatedAt": "2026-09-08T10:00:00.000+07:00"
}
~~~

tag can be null.
description and dueAt can be null.
Quest detail adds images.

### 16.2 Quest Image

~~~json
{
  "imageId": "image-uuid",
  "fileId": "file-uuid",
  "position": 0,
  "url": "temporary-url",
  "urlExpiresAt": "2026-09-08T10:15:00.000+07:00"
}
~~~

Public detail omits fileId.

### 16.3 Assignment

~~~json
{
  "id": "assignment-uuid",
  "questId": "quest-uuid",
  "workerId": "worker-uuid",
  "state": "ASSIGNMENT_ACTIVE",
  "questState": "QUEST_ASSIGNED",
  "startedAt": null,
  "createdAt": "2026-09-08T10:00:00.000+07:00"
}
~~~

### 16.4 Application

~~~json
{
  "id": "application-uuid",
  "questId": "quest-uuid",
  "memberId": "member-uuid",
  "state": "APPLICATION_APPLIED",
  "appliedAt": "2026-09-08T10:00:00.000+07:00"
}
~~~

### 16.5 Quest Edit Request

~~~json
{
  "requestId": "request-uuid",
  "questId": "quest-uuid",
  "status": "EDIT_REQUEST_PENDING",
  "failureCode": null,
  "createdAt": "2026-09-30T08:00:00.000+07:00",
  "expiresAt": "2026-09-30T08:10:00.000+07:00",
  "appliedAt": null,
  "failedAt": null,
  "previousCondition": {
    "items": [
      { "position": 0, "text": "Old condition" }
    ]
  },
  "proposedCondition": {
    "items": [
      { "position": 0, "text": "New condition" }
    ]
  },
  "responseSummary": {
    "totalCount": 1,
    "acceptedCount": 0,
    "declinedCount": 0,
    "pendingCount": 1
  },
  "responses": [
    {
      "workerId": "worker-uuid",
      "decision": null,
      "reason": null,
      "respondedAt": null
    }
  ],
  "ownResponse": null
}
~~~

failureCode can be EDIT_REQUEST_DECLINED, EDIT_REQUEST_TIMEOUT,
ACTIVE_WORKER_LEFT, or null.
status can be EDIT_REQUEST_PENDING, EDIT_REQUEST_APPLIED, or
EDIT_REQUEST_FAILED.

## 17. Complete endpoint catalog

The current Quest v2 route set has 45 endpoints:

| # | Method | Path | Main actor |
| ---: | --- | --- | --- |
| 1 | GET | /api/v2/quests | authenticated Board reader |
| 2 | POST | /api/v2/quests | Hirer |
| 3 | GET | /api/v2/quests/mine | Hirer |
| 4 | POST | /api/v2/quests/:questId/edit-requests | Hirer |
| 5 | GET | /api/v2/quests/edit-requests/:requestId | Hirer or active Worker |
| 6 | POST | /api/v2/quests/edit-requests/:requestId/respond | active Worker |
| 7 | PATCH | /api/v2/quests/:questId | Hirer with Draft |
| 8 | POST | /api/v2/quests/:questId/images | Hirer with Draft |
| 9 | DELETE | /api/v2/quests/:questId/images/:imageId | Hirer with Draft |
| 10 | POST | /api/v2/quests/:questId/publish | Hirer |
| 11 | POST | /api/v2/quests/:questId/cancel | Hirer |
| 12 | GET | /api/v2/quests/:questId/publish-check | Hirer |
| 13 | GET | /api/v2/quests/:questId/public | authenticated non-owner |
| 14 | GET | /api/v2/quests/:questId/participation | Assignment holder |
| 15 | GET | /api/v2/quests/:questId | owning Hirer |
| 16 | GET | /api/v2/assignments/mine | Worker |
| 17 | GET | /api/v2/quests/:questId/assignments | Hirer or active Worker |
| 18 | POST | /api/v2/quests/:questId/join | Prospective Worker |
| 19 | GET | /api/v2/quests/:questId/underfilled | Hirer or active Worker |
| 20 | POST | /api/v2/quests/:questId/underfilled/decision | Hirer |
| 21 | POST | /api/v2/quests/:questId/underfilled/consent | active Worker |
| 22 | POST | /api/v2/quests/:questId/applications | Candidate |
| 23 | GET | /api/v2/quests/:questId/applications | Hirer or Candidate |
| 24 | GET | /api/v2/quests/:questId/applications/:applicationId | Hirer or Candidate |
| 25 | POST | /api/v2/quests/:questId/applications/:applicationId/withdraw | Candidate |
| 26 | POST | /api/v2/quests/:questId/applications/:applicationId/select | Hirer |
| 27 | POST | /api/v2/quests/:questId/teams | Prospective Worker |
| 28 | GET | /api/v2/quests/:questId/teams | Hirer or Team member |
| 29 | GET | /api/v2/quests/:questId/teams/:teamId | Hirer or Team member |
| 30 | PATCH | /api/v2/quests/:questId/teams/:teamId | Team Leader |
| 31 | POST | /api/v2/quests/:questId/teams/:teamId/join | Prospective Worker |
| 32 | POST | /api/v2/quests/:questId/teams/:teamId/leave | Team member |
| 33 | DELETE | /api/v2/quests/:questId/teams/:teamId/members/:memberId | Team Leader |
| 34 | POST | /api/v2/quests/:questId/teams/:teamId/join-code | Team Leader |
| 35 | POST | /api/v2/quests/:questId/teams/:teamId/submit | Team Leader |
| 36 | POST | /api/v2/quests/:questId/teams/:teamId/select | Hirer |
| 37 | POST | /api/v2/quests/:questId/proof-submissions | Worker |
| 38 | PATCH | /api/v2/quests/:questId/proof-submissions/:proofSubmissionId | Proof owner |
| 39 | DELETE | /api/v2/quests/:questId/proof-submissions/:proofSubmissionId | Proof owner |
| 40 | POST | /api/v2/quests/:questId/proof-submissions/:proofSubmissionId/submit | Proof owner |
| 41 | POST | /api/v2/quests/:questId/proof-submissions/:proofSubmissionId/review | Hirer |
| 42 | GET | /api/v2/quests/:questId/proof-submissions | permitted participant |
| 43 | POST | /api/v2/quests/:questId/completion-confirmation | Worker |
| 44 | POST | /api/v2/quests/:questId/reviews | Hirer or Worker |
| 45 | PATCH | /api/v2/quests/:questId/reviews/:reviewId | review author |

## 18. Error handling checklist

For every response:

1. Check HTTP status.
2. Check success.
3. If success is false, branch on error.code.
4. Preserve the idempotency key for a safe retry.
5. Refresh the resource after a conflict or successful command.

Recommended mapping:

| Error code | Frontend action |
| --- | --- |
| VALIDATION | Show field or request validation |
| QUEST_NOT_FOUND | Remove stale resource or show not found |
| QUEST_NOT_OPEN | Refresh Quest and disable join, apply, or team action |
| QUEST_NOT_DRAFT | Refresh Quest and leave Draft editor |
| QUEST_EDIT_CONFLICT | Refresh Quest and ask the user to review |
| QUEST_FULL | Refresh Board or Team state |
| ASSIGNMENT_ALREADY_EXISTS | Read Assignments and continue as Worker |
| IDEMPOTENCY_KEY_REUSED | Stop; do not change key or body silently |
| IDEMPOTENCY_IN_PROGRESS | Retry with same key after a short delay |
| IDEMPOTENCY_UNAVAILABLE | Keep retry state and use same key |
| WORK_CHAT_UNAVAILABLE | Do not show the assignment as fully ready until result is known |
| QUEST_IMAGE_STORAGE_UNAVAILABLE | Keep Draft and show retry |
| QUEST_ESCROW_UNAVAILABLE | Keep Draft and show retry |

Keep the raw error.code for diagnostics.
Provide a safe retry or refresh action when a command may have completed.

## 19. Frontend completion criteria

The Quest v2 integration is complete only when all items below are true:

- [ ] The client uses the success/data and success/error response envelopes.
- [ ] The client sends an authenticated session on every v2 request.
- [ ] The client sends Idempotency-Key on every state-changing command.
- [ ] The client retries uncertain commands with the same idempotency key.
- [ ] The client uses Bangkok +07:00 schedule values.
- [ ] The client uses exact money values and Satang fields when present.
- [ ] The client uses If-Match for Draft edits.
- [ ] The client refreshes temporary image URLs after expiry.
- [ ] The client selects the correct mode and participation branch.
- [ ] The client does not call or invent a v2 Start Work endpoint.
- [ ] The client handles automatic QUEST_ASSIGNED to QUEST_IN_PROGRESS.
- [ ] The client does not grant Work Chat membership.
- [ ] The client does not confuse Candidate Inquiry Conversation with Work Chat.
- [ ] The client does not send Chat Attachment IDs as Candidate Team fileIds.
- [ ] The client handles SINGLE and GROUP completion separately.
- [ ] The client handles proof-required and proof-not-required completion separately.
- [ ] The client renders cancellation settlement from returned Satang values.
- [ ] The client prevents reviews outside terminal state or the review window.
- [ ] The client handles documented conflict and idempotency codes.

## 20. Known contract gaps

### 20.1 No v2 Start Work command

The lifecycle requires an automatic start transition.
The current v2 route set has no Start Work endpoint.
The frontend must wait for the lifecycle worker and refresh state.

### 20.2 Candidate Team file upload identifier gap

Candidate Team submission requires private fileIds.
Chat upload returns Chat Attachment IDs.
There is no documented generic file upload route that returns the required
private fileId.
Do not build an ID conversion assumption.

### 20.3 Work Chat is v1

Quest commands are v2, but Work Chat and Candidate Inquiry Conversation use
the /api/v1/chat routes.
Do not add /api/v2 to those chat routes.

When one of these gaps blocks a user journey, report the missing backend
contract. Do not silently invent a frontend workaround.
