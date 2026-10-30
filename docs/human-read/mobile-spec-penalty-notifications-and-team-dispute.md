# Mobile Spec: Notification Inbox v2 and Team Dispute Split

For the mobile team. Two API features. All routes use the prefix `/api/v1` and the Better Auth session. All success bodies are `{ "success": true, "data": ... }`.

| Feature                                  | API status                                                                    |
| ---------------------------------------- | ----------------------------------------------------------------------------- |
| 1. Notification inbox (Penalty, Quest, Dispute) | Penalty part merged to `develop` (PR 823). Inbox v2 (ADR 0037) is in progress. |
| 2. Candidate Team Dispute Case and split | PR 825, not merged yet. Do not ship against it until it merges to `develop`. |

---

## 1. Member Penalty Notifications and inbox

### 1.1 Push (FCM, data-only)

Five new Member-level types. They have no `questId` in the Push data. They are critical Events: the Member cannot mute them.

| `type`                     | Send to              | When                                                  |
| -------------------------- | -------------------- | ----------------------------------------------------- |
| `PENALTY_RED_FLAG_APPLIED` | the Member           | A Red Flag starts                                     |
| `PENALTY_RED_FLAG_EXPIRED` | the Member           | The Red Flag expires, or an Admin action clears it    |
| `PENALTY_BAN_APPLIED`      | the Member           | A temporary or permanent ban starts                   |
| `PENALTY_BAN_ENDED`        | the Member           | A temporary ban expires or is reversed                |
| `CONDUCT_REPORT_UPHELD`    | the reported Member  | An Admin upholds a Conduct Report                     |

Data payload (all values are strings; the client records `eventKey` before it shows an alert, as for other Push):

```json
{
  "type": "PENALTY_RED_FLAG_APPLIED",
  "eventKey": "penalty-applied:<id>",
  "notificationId": "uuid",
  "transitionId": "string",
  "result": "RED_FLAG | TEMPORARY_BAN | PERMANENT_BAN",
  "ladder": "MISCONDUCT | REVIEW",
  "source": "REPORT_CASE | CONDUCT_REPORT | REVIEW_AVERAGE",
  "expiresAt": "ISO date-time"
}
```

Rules for the client:

- `expiresAt` is absent for a permanent ban. `source` can be absent for a penalty that an Admin adds directly. Treat `result`, `ladder`, `source`, `expiresAt`, and `questId` as optional.
- Inbox v2: `CONDUCT_REPORT_UPHELD` now always has `notificationId`. Every inbox-type Push also carries `category` and `route` (see 1.4). Use `eventKey` for deduplication.
- The Push never names the reporter. It holds no Message text, proof, or filed reason. Do not try to show them.
- The server sends no localized text. Write Thai and English copy in the app, from `type` and `result`. (The FCM `title` and `body` fields are fixed English and only a fallback.)
- Deep link: `kuquestmobile://notifications`. The old `kuquest://` scheme is retired. App builds also use `kuquestmobile-staging` and `kuquestmobile-uat`. A later release can link to the Profile penalty card (`GET /profile/penalty-status`).
- A `PENALTY_BAN_APPLIED` Push can reach the device. See 1.5 for what a banned Member can read.

### 1.2 Inbox routes

All routes need a session. A banned Member with an existing session can use the inbox routes and the events socket (see 1.5). Unknown body fields give `400`.

**`GET /notifications`**: newest first.

| Query        | Type               | Rule                    |
| ------------ | ------------------ | ----------------------- |
| `limit`      | integer            | 1 to 50, default 20     |
| `cursor`     | string             | Opaque. Use `nextCursor`. A bad cursor gives `400 INVALID_CURSOR` |
| `unreadOnly` | boolean            | Default false           |
| `category`   | `PENALTY`, `QUEST`, `DISPUTE` | Repeatable. No value means all categories |

```json
{
  "items": [
    {
      "id": "uuid",
      "type": "PENALTY_BAN_APPLIED",
      "createdAt": "date-time",
      "readAt": "date-time | null",
      "questId": "uuid | null",
      "result": "RED_FLAG | TEMPORARY_BAN | PERMANENT_BAN | null",
      "expiresAt": "date-time | null",
      "category": "PENALTY | QUEST | DISPUTE",
      "questTitle": "string | null",
      "actorRole": "HIRER | WORKER | null",
      "cancellationReason": "string | null",
      "failureReason": "string | null",
      "assignmentId": "uuid | null",
      "disputeCaseId": "uuid | null",
      "disputeStatus": "string | null",
      "viewerWon": "boolean | null"
    }
  ],
  "nextCursor": "string | null"
}
```

`nextCursor` is `null` on the last page. `id` equals `notificationId` in the Push. The new fields are additive. A field that does not apply is `null` or absent.

**`GET /notifications/unread-count`** returns `{ "count": 0, "byCategory": { "PENALTY": 0, "QUEST": 0, "DISPUTE": 0 } }`. Use it for the badge and the tab badges.

**`POST /notifications/read`**: send exactly one form.

```json
{ "ids": ["uuid"] }
```

```json
{ "all": true }
```

```json
{ "all": true, "category": "QUEST" }
```

- `ids` has 1 to 100 UUIDs. Send both forms, or neither, and you get `400 INVALID_NOTIFICATION_READ_TARGET`.
- `category` is allowed only together with `all`. `category` with `ids` also gives `400 INVALID_NOTIFICATION_READ_TARGET`. An unknown field or an unknown `category` value gives a plain `400` validation error without that code.
- It is idempotent. A repeat call succeeds and keeps the first `readAt`. An id of another Member is ignored.

**`POST /notifications/dismiss`**: hide rows from the list.

```json
{ "ids": ["uuid"] }
```

- `ids` has 1 to 100 UUIDs. It is idempotent, and it also marks the rows read.
- Dismiss hides a row. It does not delete it. A penalty row cannot be dismissed: you get `400 NOTIFICATION_NOT_DISMISSABLE`. Do not show a dismiss action on a penalty row.

### 1.3 Types, categories, and row fields

The inbox holds 15 types in 3 categories.

| Category  | Types                                                                                                                                                                                                      |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PENALTY` | `PENALTY_RED_FLAG_APPLIED`, `PENALTY_RED_FLAG_EXPIRED`, `PENALTY_BAN_APPLIED`, `PENALTY_BAN_ENDED`, `CONDUCT_REPORT_UPHELD`                                                                                |
| `QUEST`   | `UNDERFILLED_DECISION_PENDING`, `UNDERFILLED_CONSENT_PENDING`, `UNDERFILLED_COMPLETED`, `UNDERFILLED_CANCELLED`, `QUEST_ASSIGNED`, `PROOF_NOT_APPROVED`, `QUEST_COMPLETED_DISPUTE_WINDOW_OPEN`, `QUEST_FAILED` |
| `DISPUTE` | `DISPUTE_CASE_FILED_AGAINST_YOU`, `DISPUTE_CASE_DECIDED`                                                                                                                                                   |

The Dispute Events have **no Push**. They reach the app by the inbox and the events socket only. Each Quest Event row is created in the same transaction as its Push, so a Quest Push always has a row.

| Field                | Meaning                                                                                      |
| -------------------- | -------------------------------------------------------------------------------------------- |
| `questTitle`         | Quest title, a snapshot at Event time. It does not change if the Quest title changes later.  |
| `actorRole`          | `HIRER` or `WORKER`: the role of the viewer in the Quest.                                    |
| `cancellationReason` | `HIRER_CANCELLED`, `HIRER_NO_DECISION`, `WORKER_DECLINED`, `CONSENT_TIMEOUT`.                |
| `failureReason`      | `PROOF_NOT_APPROVED`, `COMPLETION_NOT_APPROVED`, `DUE_AT_MISSED`.                            |
| `assignmentId`       | The Assignment of the Event.                                                                 |
| `disputeCaseId`      | The Dispute Case of a `DISPUTE` row.                                                         |
| `disputeStatus`      | The Dispute Case status at Event time.                                                       |
| `viewerWon`          | On `DISPUTE_CASE_DECIDED`: true if the viewer won. The filer wins when the case is `RESOLVED`. The respondent wins when it is `DISMISSED`. |

Rules for the client:

- The Server sends codes, never localized text. Write Thai and English copy in the app.
- A row never holds the reporter, the filed reason, proof, Message text, an amount, or data of the other party. Do not try to show them.
- An expired `*_PENDING` row stays **unread**. Use `expiresAt` to show it as expired. The Server does not mark it read.
- Handle an unknown `type` or `category` as a generic row.

### 1.4 Push data for inbox types

Every inbox-type Push now carries, in addition to the keys in 1.1:

| Key              | Value                                                                  |
| ---------------- | ---------------------------------------------------------------------- |
| `notificationId` | The inbox row ID. Always present, `CONDUCT_REPORT_UPHELD` included.    |
| `category`       | `PENALTY` or `QUEST`.                                                  |
| `route`          | The app route to open, for example `/notifications` or `/quest/{questId}`. |

Existing keys and `transitionId` stay. Deep link schemes: `kuquestmobile://`, `kuquestmobile-staging://`, `kuquestmobile-uat://`.

### 1.5 Realtime and banned Members

**Socket**: `GET /api/v1/notifications/events` (WebSocket). It uses the same Origin and Cookie rules as `/api/v1/wallet/events`. On connect, the Server sends one `{ "type": "SUBSCRIBED", "version": 1 }` frame. Ignore it. The Server sends no heartbeat ping, so do not wait for one. The only change frame is:

```json
{ "type": "NOTIFICATIONS_CHANGED" }
```

The frame has no payload. When it arrives, refetch `unread-count` and the first page of `GET /notifications`. The Server sends it after commit when it creates a row.

**Banned Member**: The inbox routes and the events socket skip the ban guard. A banned Member with an **existing session** gets `200` from the own inbox and can connect to the socket. Every other route still returns `403 MEMBER_BANNED`. New sign-in stays denied.

Limits to know:

- A ban does not revoke an existing session today. A Member who is signed out (for example a permanent ban) cannot sign in, so that Member cannot read the row. Show the explanation from the `PENALTY_BAN_APPLIED` Push.
- The public ban-status route is **not built**. A public route was not chosen because it needs a new unauthenticated surface and an identity proof (ADR 0037).

### 1.6 Scope and open product points

- The inbox does not hold Work Conversation Messages (chat has its own unread state), Payout status, or Top-up status. Retention is at least 90 days, then the Server hard-deletes the row. See ADR 0035 and ADR 0037.
- `redFlagged` (Member data) and `hirerRedFlagged` (Quest data) mean "a Red Flag is active now". They turn `false` at the expiry time, a short time before the `PENALTY_RED_FLAG_EXPIRED` Event.
- The notification center needs a route and a Mobile Surface entry. This is a product decision for your team.

---

## 2. Candidate Team Dispute Case and payout split

Applies to a `GROUP + CANDIDATE` Quest in `QUEST_FAILED`. The 7-day money hold and the filing windows do not change.

### 2.1 Flow

1. The **Team Leader** files one Dispute Case for the whole Candidate Team. A Team member who is not the Team Leader cannot file.
2. An Admin decides. If the team wins, the Admin approves an **amount**. No money moves yet.
3. The Team Leader has **24 hours** to split the amount by percentage between all members, the Team Leader included.
4. After the Team Leader confirms, the system pays each member by share. A confirmed split cannot change.
5. If the Team Leader does not split in 24 hours, the system splits equally and pays.
6. If the money cannot be paid yet, nobody is paid. The system retries. This is shown as `paymentPending`.

### 2.2 What to read: the `dispute` field

The Quest detail responses (v2) carry `dispute`. It is `null` unless the Quest is `QUEST_FAILED` (or `QUEST_COMPLETED` with an unpaid slot). Use it to choose the screen.

```json
{
  "canFile": true,
  "windowEndsAt": "date-time | null",
  "viewerRole": "HIRER | TEAM_LEADER | TEAM_MEMBER | WORKER",
  "myCase": { "id": "uuid", "displayId": "string", "status": "string", "createdAt": "date-time" },
  "teamCase": { "id": "uuid", "displayId": "string", "status": "string", "createdAt": "date-time" },
  "teamSplit": { }
}
```

| Field          | Meaning                                                                                      |
| -------------- | -------------------------------------------------------------------------------------------- |
| `canFile`      | The server decision. Show the file button only when true. Always false for `TEAM_MEMBER`.    |
| `windowEndsAt` | End of the filing window. Show a countdown from this value.                                  |
| `viewerRole`   | `TEAM_LEADER`: file and split. `TEAM_MEMBER`: read only. `HIRER` and `WORKER`: as before.    |
| `myCase`       | The caller's own case, or `null`.                                                            |
| `teamCase`     | The Team's case. Every Team member sees it.                                                  |
| `teamSplit`    | `null` until an Admin approves a team case. Then it holds the split state below.             |

### 2.3 `teamSplit`

```json
{
  "disputeCaseId": "uuid",
  "status": "AWAITING_SPLIT | SPLIT_CONFIRMED | PAID",
  "splitSource": "LEADER | AUTO_EQUAL | null",
  "approvedAmountSatang": 12345,
  "deadlineAt": "date-time",
  "confirmedAt": "date-time | null",
  "paidAt": "date-time | null",
  "paymentPending": false,
  "viewerIsLeader": true,
  "canSubmitSplit": true,
  "members": [
    {
      "memberId": "uuid",
      "displayName": "string",
      "isLeader": true,
      "percentageBasisPoints": "0..10000 | null",
      "amountSatang": "integer | null",
      "paidAt": "date-time | null"
    }
  ]
}
```

Money is in **integer Satang** (100 Satang = 1 Baht). Never use floating point.

| `status`          | Team Leader screen                                      | Member screen                                  |
| ----------------- | ------------------------------------------------------- | ---------------------------------------------- |
| `AWAITING_SPLIT`  | Split form. Enabled only when `canSubmitSplit` is true. Countdown to `deadlineAt`. | "Waiting for the Team Leader to split." Countdown. |
| `SPLIT_CONFIRMED` | Read only. If `paymentPending`, show "Payment is being processed." | Same, with each share.                         |
| `PAID`            | Paid per member (`paidAt`).                             | Own amount and `paidAt`.                       |

- Before the split, `percentageBasisPoints` and `amountSatang` are `null` for every member.
- `splitSource` is `AUTO_EQUAL` after the deadline passes with no split. Say so in the UI.
- Never compute the amounts on the client. Read `amountSatang`. The server rounds down and gives the leftover Satang to the largest remainders, then to the earliest member.

### 2.4 Routes

**`GET /quests/:questId/disputes/team-split`** returns `teamSplit` (shape above). Any Team member can read it.

**`POST /quests/:questId/disputes/team-split`**: only the Team Leader, and only while `canSubmitSplit` is true.

- Header `Idempotency-Key`: required, 1 to 200 characters. Make one key per submit attempt. Reuse the same key when you retry the same body.
- Body:

```json
{
  "shares": [
    { "memberId": "uuid", "percentageBasisPoints": 5000 },
    { "memberId": "uuid", "percentageBasisPoints": 3000 },
    { "memberId": "uuid", "percentageBasisPoints": 2000 }
  ]
}
```

- Every Team member appears once, the Team Leader included. The total must be exactly **10000** (1 basis point = 0.01%). A share can be 0. Allow 2 to 20 entries. Show the form as percent with two decimals and convert to basis points.
- Response: `teamSplit` with `status` `SPLIT_CONFIRMED` (or `PAID`).

**`POST /quests/:questId/disputes`** (file a Dispute Case): unchanged for the Hirer. For a Team member who is not the Team Leader it returns `403 DISPUTE_CASE_TEAM_LEADER_ONLY`. Do not show the button when `canFile` is false.

### 2.5 Errors

| Status | Code                               | Meaning and client action                                                    |
| ------ | ---------------------------------- | ---------------------------------------------------------------------------- |
| 400    | `DISPUTE_TEAM_SPLIT_INVALID`       | A member is missing or repeated, or the total is not 10000. Fix the form.    |
| 403    | `DISPUTE_TEAM_SPLIT_NOT_AUTHORIZED`| Not the Team Leader. Show the read-only screen.                              |
| 403    | `DISPUTE_CASE_TEAM_LEADER_ONLY`    | A Team member tried to file. Show the read-only screen.                      |
| 409    | `DISPUTE_CASE_ASSIGNMENT_COMPLETED`| The Worker already received the Reward (`GROUP + FIRST_COME_FIRST_SERVED`). `canFile` is false. Do not show the file button. |
| 404    | `DISPUTE_TEAM_SPLIT_NOT_FOUND`     | No split for this Member and Quest.                                          |
| 409    | `DISPUTE_TEAM_SPLIT_EXPIRED`       | The 24-hour deadline passed. Reload. The system splits equally.              |
| 409    | `DISPUTE_TEAM_SPLIT_NOT_READY`     | No approved amount yet, or the split is already confirmed. Reload.           |
| 503    | (service)                          | Retry later with the same `Idempotency-Key`.                                 |

### 2.6 Notes for the app

- Poll or reload `dispute` when the Quest screen opens. This release adds no Push type for the split. Use the existing Quest update events if your screen already listens to them.
- Show `deadlineAt` in the user's time zone. The wire time is an ISO date-time.
- Payment proof per member is `paidAt` in `members`. The ledger transaction id stays on the server.

---

## Source of truth

`/openapi/json` after the API deploys. Operation ids: `listMemberNotifications`, `countUnreadMemberNotifications`, `markMemberNotificationsRead`, `dismissMemberNotifications`, `getQuestDisputeTeamSplit`, `submitQuestDisputeTeamSplit`, `fileQuestDispute`. Rulebooks: `docs/rulebook/quest/notification-audit-contract.md`, `docs/rulebook/admin/admin-dispute-case-contract.md`. ADRs: 0035, 0036, 0037.
