# Portable Frontend Handoff: Quest API v2

Read this file when a Frontend or Mobile task covers a `Hirer` who creates,
edits, checks, or publishes a `Quest` through `/api/v2`. This file is portable:
it contains the required Quest context for an agent in another repository.

The target contract is [Spec #336](https://github.com/KUQuest/KUQuest-API-Server/issues/336),
part of [Wayfinder Map #319](https://github.com/KUQuest/KUQuest-API-Server/issues/319).

## Cross-repository context

The Frontend repository and the Backend repository use different context files.
Use this bridge for this task:

| Frontend context | Quest API v2 context |
| --- | --- |
| `KU User` | `Member`: the authenticated KUQuest identity. |
| A user who creates a Quest | `Hirer`: the Member who owns that Quest. `Hirer` is a role, not a new account type. |
| A user who performs a Quest | `Worker`: the Member who receives an Assignment. |
| App or screen state | `Quest State`: the Server-owned lifecycle value such as `QUEST_DRAFT` or `QUEST_OPEN`. |
| User-entered budget | `Quest Funding Total`: the inclusive amount for one Worker slot. |
| Location input | A label-only location. It is not latitude, longitude, GPS, address, distance, or a map object. |
| Image picker result | `Quest Image`: an optional image resource owned by the Quest. |

`Onboarding`, `Profile`, `Wallet`, and Work Chat are separate domains. This
handoff covers the Hirer Quest Draft-to-Open boundary only. A Frontend
`CONTEXT.md` that does not yet define Quest terms does not remove the rules in
this file.

Use these exact names in API types, state values, analytics, and UI-to-API
mapping:

- Quest States: `QUEST_DRAFT`, `QUEST_OPEN`, `QUEST_ASSIGNED`,
  `QUEST_IN_PROGRESS`, `QUEST_COMPLETED`, `QUEST_CANCELLED`, and
  `QUEST_FAILED`.
- Quest modes: `FIRST_COME_FIRST_SERVED` and `CANDIDATE`.
- Participation shapes: `SINGLE` and `GROUP`.
- Money terms: `Quest Funding Total`, `Quest Reward`, `Platform Fee`, `Quest
  Escrow`, `Spending Balance`, and `Funding Reservation`.

## Source of truth

Use the following order when sources disagree:

1. The generated Backend OpenAPI contract, when it is available for the
   endpoint.
2. [Spec #336](https://github.com/KUQuest/KUQuest-API-Server/issues/336), which
   defines the accepted v2 contract.
3. This handoff for the cross-repository context bridge and Client behavior.
4. The Frontend repository's `AGENTS.md`, `CONTEXT.md`, and code style for
   platform, navigation, translation, and testing conventions.

When the Backend repository is available, its supporting references are
`CONTEXT.md`, `docs/quest/work-chat-system-target.md`, and ADR 0024/0025. They
explain the domain decisions. The Frontend task still uses the v2 contract
above; legacy v1 behavior remains a separate adapter.

The Backend delivery order is:

- [#338](https://github.com/KUQuest/KUQuest-API-Server/issues/338): Draft
  foundation, create, list, and detail.
- [#339](https://github.com/KUQuest/KUQuest-API-Server/issues/339): Draft edit
  and optimistic concurrency; blocked by #338.
- [#340](https://github.com/KUQuest/KUQuest-API-Server/issues/340): publish
  check and funding quote; blocked by #338.
- [#341](https://github.com/KUQuest/KUQuest-API-Server/issues/341): Quest
  Image gallery; blocked by #338.
- [#342](https://github.com/KUQuest/KUQuest-API-Server/issues/342): publish
  and Quest Escrow; blocked by #340.
- [#343](https://github.com/KUQuest/KUQuest-API-Server/issues/343): complete
  v2 flow and v1 compatibility; blocked by #339, #340, #341, and #342.

## Target outcome

Provide one reliable Frontend journey:

`create Draft → edit Draft → manage Quest Images → check publish → publish`

The Client owns form state, screen state, retry presentation, and recoverable
local data. The Server owns validation, time, money, ownership, Quest State,
temporary URLs, and command results.

## Agent sequence

### 1. Establish the v2 Client boundary

Create explicit v2 request, response, and error types. Keep the API version in
the transport boundary so v1 and v2 fields cannot mix.

| Operation | Endpoint | Client rule | Result |
| --- | --- | --- | --- |
| Create Draft | `POST /api/v2/quests` | `Idempotency-Key` required | Canonical Quest in `QUEST_DRAFT` |
| List own Quests | `GET /api/v2/quests/mine` | Read; no idempotency key | `{ items, nextCursor }` |
| Read own Quest | `GET /api/v2/quests/:questId` | Read; no idempotency key | Canonical Quest |
| Edit Draft | `PATCH /api/v2/quests/:questId` | `If-Match` and `Idempotency-Key` required | Updated canonical Quest |
| Add Quest Images | `POST /api/v2/quests/:questId/images` | Multipart `images` and `Idempotency-Key` required | Current ordered `images` |
| Remove Quest Image | `DELETE /api/v2/quests/:questId/images/:imageId` | `Idempotency-Key` required | Current ordered `images` |
| Check publish | `GET /api/v2/quests/:questId/publish-check` | Read; no idempotency key | Readiness and funding quote |
| Publish Quest | `POST /api/v2/quests/:questId/publish` | Empty business body and `Idempotency-Key` required | `QUEST_OPEN` Quest and Quest Escrow snapshot |

Use the existing authenticated Session transport from the Frontend repository.
Use the exact field representation from OpenAPI for money and dates. Keep
`Idempotency-Key` stable for one intent and generate a new key for a changed
intent.

Completion criterion: every request in the journey uses a v2 type and endpoint;
the v1 adapter has no silent field reuse.

### 2. Build the Draft editor

The create request requires:

- `title`: trimmed, 1–120 characters.
- `condition.items`: at least one ordered, non-blank item; each item is at
  most 255 characters.
- `mode`: `FIRST_COME_FIRST_SERVED` or `CANDIDATE`.
- `participation`: `SINGLE` or `GROUP`.
- `questFundingTotal`: inclusive amount in Baht for one Worker slot, with exact
  satang precision.
- `headcount`: 1–20; `SINGLE` requires `1`.
- `startTime`: ISO-8601 date-time with an explicit timezone.

Draft-only optional fields are:

- `description`: nullable, at most 1,000 characters.
- `dueAt`: nullable while the Quest is a Draft.
- `tagId`: nullable while the Quest is a Draft.
- `proofRequired`: defaults to `true`.
- `locations`: zero to ten label-only objects; each label is at most 100
  characters.

Keep two values in Client state:

- `canonicalQuest`: the last resource confirmed by the Server.
- `draftForm`: the current local form, including unsaved edits.

`PATCH /api/v2/quests/:questId` is a top-level partial update:

- An omitted field stays unchanged.
- `null` clears a nullable field.
- `locations: []` clears every location.
- A supplied `condition.items` replaces the complete ordered Condition Item
  collection.
- A supplied `locations` replaces the complete location collection.
- Required fields remain present.
- An empty body is invalid.
- `If-Match` uses the value supplied by the API. The Client does not derive it
  from `updatedAt` or local time.

An online Quest can use `locations: []`. Zero Quest Images also remains valid.
An incomplete Draft may have no canonical `Tag` and no `dueAt`; publish check
reports those later.

Completion criterion: the editor creates an incomplete Draft, saves valid
partial edits, replaces Conditions and locations as complete collections, and
shows a review path after a stale `If-Match` conflict.

### 3. Present the inclusive money model

The Hirer enters `questFundingTotal`. This is the complete budget for one
Worker slot. The Client presents it as the budget and lets the Server derive:

- net `questReward` for the Worker;
- `platformFee` for the Platform; and
- the exact inclusive total.

The Platform Fee is inside the entered total. The Client displays the quote
returned by the Server and uses integer satang in local form handling. It keeps
the Server as the only calculation authority.

Contract fixtures:

- Total ฿20.00 at 2%: Quest Reward ฿19.60 and Platform Fee ฿0.40.
- Total ฿1.03 at 2%: Quest Reward ฿1.00 and Platform Fee ฿0.03. A ฿1.01
  Reward would require ฿0.03 and exceed the total.

Hirer-owned responses may contain `questFundingTotal`, `questReward`,
`platformFee`, fee rate, rounding mode, Money Policy revision, and an opaque
reservation reference. Worker and public views show the applicable Quest
Reward only. Shared components must keep Platform Fee, Money Policy, Wallet,
and Funding Reservation details out of those views.

Completion criterion: the UI has one exact Hirer budget, shows the net Worker
Reward and Platform Fee as parts of that budget, and uses the Server quote for
all displayed calculations.

### 4. Manage Quest Images as a separate resource

Create the Draft before uploading images. Keep image operations separate from
Draft create and Draft PATCH.

Image contract:

- Upload uses multipart field `images`.
- Accepted file formats are JPEG, PNG, and WebP.
- Each file is at most 5 MB; a Quest has zero to three images.
- The Server checks decoded file content and actual byte size.
- Upload appends images in request order.
- A batch that exceeds the image limit fails as one batch.
- Replacement is explicit: remove the old image, then upload the new image.
- Remove by `imageId`. `fileId` is a file reference, not the image resource
  identity.
- After remove, render the returned list. The Server repacks positions from
  `0`.
- Each image has `imageId`, `fileId`, `position`, `url`, and `urlExpiresAt`.
- Temporary links are valid for 15 minutes and are generated on read.
- Quest Images are optional and are not shown on the Quest Board card.
- Image writes are allowed for the owning Hirer only while the Quest is
  `QUEST_DRAFT`.

Keep selected files available after a correctable failure. On a successful
remove or upload, replace local image state with the complete Server list. On
an expired or failed temporary URL, reload the Quest resource. The Client does
not persist or display a permanent storage URL.

Completion criterion: the image manager supports ordered add, remove,
replacement, retry, limit feedback, and expired-link recovery without changing
Draft text or money state.

### 5. Build publish readiness

`GET /api/v2/quests/:questId/publish-check` is an advisory read. It does not
save the Draft, change Quest State, reserve money, or upload files.

Render every returned `blockingReasons` entry, every `warnings` entry, and the
funding quote. Known blockers include:

- missing canonical `Tag`;
- missing or invalid `dueAt`;
- `dueAt <= startTime`;
- `startTime` is not in the future by Server time;
- invalid Quest Condition;
- insufficient `Spending Balance` for Quest Escrow;
- `Wallet Status` is not `ACTIVE`; and
- the total Quest Escrow amount is outside the active Money Policy's
  Funding Reservation limits.

`QUEST_ESCROW_AMOUNT_OUT_OF_RANGE` is returned when the headcount-multiplied
Quest Escrow amount is below or above those active limits. This is a
publish-check blocker because the later Funding Reservation would reject the
same amount. A missing Wallet or unavailable Money Policy is a dependency
failure and returns `503 QUEST_ESCROW_UNAVAILABLE`.

Empty locations and zero Quest Images are valid. They are neither blockers nor
warnings.

Keep the current form while the check is loading. If the response shows a
changed Quest or a conflict, reload the canonical resource and let the Hirer
review unsaved local edits before replacing them.

Completion criterion: the readiness screen shows all Server blockers, warnings,
and the current quote, with a route back to each affected Draft field.

### 6. Publish with safe retry

Publish has no business request body. The request identifies the Draft in the
path and uses a stable `Idempotency-Key`.

For each v2 write:

- Generate one key for one user intent.
- Reuse the key for a network retry of the same request.
- A same-key retry with the same request replays the original result.
- A changed request gets a new key.
- For `IDEMPOTENCY_IN_PROGRESS`, keep the same request identity and retry,
  wait, or re-read according to the transport policy.

On a confirmed success, replace the Draft view with the returned canonical
Quest in `QUEST_OPEN` and store the returned Hirer-only Quest Escrow snapshot.
The Client treats a timeout as an unknown result. It re-reads or retries with
the same key instead of inferring a local publish.

Completion criterion: a lost response cannot create a duplicate Quest State
transition or Funding Reservation, and a confirmed response drives the screen
from the returned `QUEST_OPEN` resource.

## Shared response and error contract

Success and error use these envelopes:

```json
{ "success": true, "data": {} }
```

```json
{ "success": false, "error": { "code": "...", "message": "..." } }
```

Use `error.code` for UI behavior. Treat `message` as display text or a
fallback; exact message text is not a stable contract.

| Result | Client behavior |
| --- | --- |
| `400 VALIDATION` | Keep entered data and show field or form correction. |
| `401 UNAUTHORIZED` | Restore Sign-In and preserve recoverable local Draft data. |
| `404 QUEST_NOT_FOUND` | Stop showing the resource. Missing and not-owned Quest use the same view. |
| `409 QUEST_EDIT_CONFLICT` | Reload the canonical Draft and show a review or merge path. |
| `409 QUEST_NOT_DRAFT` or `QUEST_STATE_CONFLICT` | Refresh Quest State and remove Draft-only controls. |
| `409 IDEMPOTENCY_KEY_REUSED` | Treat the request as a different intent and create a new key. |
| `409 IDEMPOTENCY_IN_PROGRESS` | Keep the same key and request identity. Retry or re-read. |
| `409` Wallet correction | Show the correction, such as insufficient Spending Balance. |
| `413` image too large | Keep the file selectable and show the 5 MB limit. |
| `415` unsupported image | Keep valid files and ask for a supported replacement. |
| `503 QUEST_IMAGE_STORAGE_UNAVAILABLE` | Keep selected files and offer retry. |
| `503 QUEST_ESCROW_UNAVAILABLE` | Keep the Draft and offer publish retry. |
| `500 INTERNAL_ERROR` | Keep recoverable local state and show a generic retry path. |

The Client uses `404` behavior for ownership failures and exposes no other
Member's Quest data.

## Client state and transport checklist

Represent these states explicitly:

- initial load, loading, loaded, and load failure;
- clean Draft, dirty Draft, save in progress, save success, and save conflict;
- image upload in progress, upload success, upload failure, and remove in
  progress;
- publish-check loading, ready, blocked, stale, and unavailable; and
- publish in progress, published, retryable failure, and Quest State conflict.

Keep API calls behind one v2 Client boundary. A mock transport may support UI
work while Backend tickets are in progress, but its fixtures must use the
shared envelope and this contract. Replace the transport at that boundary when
the Backend endpoint is available.

## Verification path

Verify these Client journeys at the API boundary:

1. Create a minimal valid `QUEST_DRAFT`.
2. Save an incomplete Draft with no `Tag`, no `dueAt`, zero locations, and
   zero images.
3. Edit title, Condition Items, label-only locations, funding total, and dates.
4. Send a stale `If-Match` and recover without silent overwrite.
5. Upload three valid images in order, remove the middle image, and verify
   positions `0` and `1`.
6. Handle unsupported format, file over 5 MB, and a fourth image.
7. Render all publish blockers in one readiness result.
8. Verify the ฿20.00 and ฿1.03 inclusive funding examples.
9. Retry create, edit, image, and publish commands with the same key and
   request; verify one result for each intent.
10. Confirm publish returns `QUEST_OPEN` and the Hirer-only Quest Escrow
    snapshot.
11. Confirm public or Worker presentation hides Platform Fee, Money Policy,
    Wallet, and Funding Reservation details.
12. Confirm v1 screens and adapters retain their existing behavior.

The handoff is complete when the Client tests cover these journeys, each listed
failure has a recoverable UI state, and the Client takes no authority over
Quest State, money split, ownership, or permanent file URLs.
