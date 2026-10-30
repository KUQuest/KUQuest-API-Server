# Notification and Audit Contract

Part of the [Quest and Work Chat Rulebook](quest-work-chat-rulebook.md). Defines accepted policy for KU bot System Messages, Android FCM Push Notifications, and Audit Record retention.

## System Message contract

- System Messages are immutable and use standard Event templates.
- They appear in the Work Conversation as messages from KU bot.
- **Events covered**: Membership changes, Proof Submission, Completion Confirmation, approval, non-approval, deadline failure, Quest completion, Quest failure, Quest cancellation, and Quest Edit outcomes.
- **Privacy and display**:
  - They include the affected Worker's system display name and Event summary, but not private proof details or full Profile data.
  - On Quest completion, a Worker sees that Worker's Reward. Other participants see completion without the amount.
  - An Admin Review Item is separate from the Work Conversation and is never exposed to other Accepted Participants.
- **Action links**: Include an Event-specific action link or button, visible only when the Member has permission. A terminal Quest Event includes a Rating Review action link for eligible Hirer or Worker pairs.

## Push Notification contract

- Production Push targets Android only directly via FCM (APNs/iPhone is out of scope).
- A Member can register and manage multiple Android Push Devices.
- Push is enabled by default after Android permission is granted.
- **Delivery and deduplication**:
  - Each logical Event produces at most one alert per recipient, even after retry.
  - FCM messages include a stable `eventKey` and use a data-only payload. The Android client records each `eventKey` before it displays an alert and ignores later copies of a recorded key. Foreground Popups use the same key.
  - Delivery state is recorded (`PUSH_DELIVERY_PENDING`, `PUSH_DELIVERY_DELIVERED`, `PUSH_DELIVERY_FAILED`, `PUSH_DELIVERY_DISABLED`).
  - Transient failures are retried. Invalid destinations end at `PUSH_DELIVERY_DISABLED`.
  - When the app is active in foreground, an in-app Popup replaces the duplicate Push.
- **Recipients**:
  - A new Message in a Work Conversation notifies every other current Accepted Participant, never the sender.
  - Directly affected Events notify the affected recipient. Quest-wide Events notify all current Accepted Participants.
  - Creating a proof-free Completion Confirmation notifies the Hirer. A Hirer or automatic decision notifies the Member who submitted the Confirmation.
  - Real-time `COMPLETION_REVIEW_PENDING` and `COMPLETION_REVIEWED` Events update the Hirer and affected Workers.
  - A `QUEST_OPEN_EDIT_UPDATED` realtime event goes to the Hirer and Members
    with an open Candidate Inquiry Conversation. It does not create a Push
    Notification.
  - An underfilled `GROUP + FCFS` Quest sends these data-only Events, one per recipient and transition:
    - `UNDERFILLED_DECISION_PENDING` to the Hirer when the decision window opens.
    - `UNDERFILLED_CONSENT_PENDING` to each Active Worker when the consent window opens.
    - `UNDERFILLED_COMPLETED` and `UNDERFILLED_CANCELLED` to each Active Worker. The cancelled Event names the cancellation reason.
    - `QUEST_ASSIGNED` to the other Active Workers when the last GROUP slot fills.
  - These Events carry `transitionId` (equal to `eventKey`) and, for a window, the server `expiresAt`. The client counts down from `expiresAt`. The Push worker does not send an Event when the underfilled state changed before delivery.
- **Muting and critical events**:
  - A Member can mute non-critical Push per Quest.
  - Critical Events remain deliverable: the five Member Penalty Notification types, approval, non-approval, missing work at `dueAt`, `QUEST_FAILED`, `QUEST_COMPLETED`, `QUEST_CANCELLED`, and Quest Edits requiring a response.
- **Privacy**: Push contains a short update and relevant link. It never contains private proof details or evidence.

### Member Penalty Notifications

A Member Penalty Notification is a Member-level Push. It has no `questId`.
The Server sends no localized text. The Android client builds the alert text from `type`, `result`, and `expiresAt`.

| `type`                     | Recipient                                       | Sent when                                                                                                         |
| -------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `PENALTY_RED_FLAG_APPLIED` | The penalized Member                            | A Red Flag becomes active.                                                                                        |
| `PENALTY_RED_FLAG_EXPIRED` | The penalized Member                            | A Red Flag reaches `expiresAt`, or a penalty removal ends it early.                                               |
| `PENALTY_BAN_APPLIED`      | The penalized Member                            | A temporary or permanent Member Ban starts.                                                                       |
| `PENALTY_BAN_ENDED`        | The penalized Member                            | A temporary Member Ban reaches `expiresAt`, or a penalty removal ends it early. A permanent ban has no end Event. |
| `CONDUCT_REPORT_UPHELD`    | The reported Member of an upheld Conduct Report | An Admin upholds the Conduct Report.                                                                              |

- **Critical Events**: All five types are critical. A Member cannot mute them, per Quest or in any other way, except by disabling a Push Device.
- **Payload**: The payload is data-only and has these fields:
  - `type`: one of the five types above.
  - `notificationId`: the stable ID of the inbox item for this Event.
  - `transitionId`: the stable ID of the penalty transition. It equals `eventKey`, so retries and client deduplication use one key.
  - `result`: `RED_FLAG`, `TEMPORARY_BAN`, or `PERMANENT_BAN`.
  - `ladder`: `MISCONDUCT` or `REVIEW`.
  - `source`: `REPORT_CASE`, `CONDUCT_REPORT`, or `REVIEW_AVERAGE`.
  - `expiresAt`: the server time at which the restriction ends. The Server omits it for a permanent ban.
- **Source of Events**: `memberPenaltyRecord` is the source of truth (see [Admin Member Penalty Contract](../admin/admin-member-penalty-contract.md)). Each applied, expired, or ended transition creates one Event per recipient. A penalty removal that ends a restriction creates the matching expired or ended Event. A direct Admin penalty action uses the same types; its `source` is the source recorded in `memberPenaltyRecord`.
- **Privacy**: The payload never contains the reporter, Message text, proof details, evidence, the Admin note, or the filed Conduct Report reason. The reported Member learns only the result and the end time.
- **Banned Members**: A banned Member cannot sign in. The Push is still sent to the Push Device. A banned Member who still has a session can read the own inbox (see the inbox contract).

### Inbox Push data

Every Push of an inbox type carries these keys in addition to its other data keys ([ADR 0037](../../adr/0037-notification-inbox-v2.md)):

- `notificationId`: the ID of the inbox item. `CONDUCT_REPORT_UPHELD` always has it.
- `category`: `PENALTY` or `QUEST`.
- `route`: the app route to open, for example `/notifications` or `/quest/{questId}`.

The existing keys and `transitionId` stay. The deep link scheme is `kuquestmobile://`. App builds also use `kuquestmobile-staging` and `kuquestmobile-uat`. The old `kuquest://` scheme is retired. The Server writes the Quest Event row in the same transaction as its Push, so a Push without a row cannot exist. The two Dispute inbox types have no Push.

## Notification inbox contract

The notification inbox is a Member's server-side list of Events. It lets a Member see an Event that the Push did not show, for example after the Member disabled a Push Device. The decisions are in [ADR 0035](../../adr/0035-member-notification-inbox.md) and [ADR 0037](../../adr/0037-notification-inbox-v2.md).

- **Content**: The inbox holds 15 types in 3 categories. It does not hold Work Conversation messages, System Messages, Payout status, or Top-up status. Chat history stays in the Work Conversation.
  - `PENALTY`: the five Member Penalty Notification types.
  - `QUEST`: `UNDERFILLED_DECISION_PENDING`, `UNDERFILLED_CONSENT_PENDING`, `UNDERFILLED_COMPLETED`, `UNDERFILLED_CANCELLED`, `QUEST_ASSIGNED`, `PROOF_NOT_APPROVED`, `QUEST_COMPLETED_DISPUTE_WINDOW_OPEN`, `QUEST_FAILED`.
  - `DISPUTE`: `DISPUTE_CASE_FILED_AGAINST_YOU`, `DISPUTE_CASE_DECIDED`. These have inbox and realtime only, with no Push. See [Admin Dispute Case Contract](../admin/admin-dispute-case-contract.md).
- **Row creation**: A Quest Event row is written in the same transaction as its Push.
- **Retention**: The Server keeps an item for at least 90 days after `createdAt`. After that, the Server hard-deletes it.
- **Scope**: A Member reads and changes only that Member's items. Every route needs a signed-in session.
- `GET /api/v1/notifications` returns the Member's items, newest first.
  - Query: `cursor` (opaque), `limit` (1 to 50, default 20), `unreadOnly` (boolean), and `category` (repeatable: `PENALTY`, `QUEST`, `DISPUTE`).
  - Response: `items` and `nextCursor`. `nextCursor` is `null` on the last page.
  - Item: `id`, `type`, `category`, `createdAt`, `readAt` (`null` when unread), `questId` (`null` for penalty and `null` when the Event has no Quest), `result`, `expiresAt`, and the envelope fields below.
- **Envelope fields** (additive; a field is `null` or absent when it does not apply):

| Field                | Value                                                                         |
| -------------------- | ----------------------------------------------------------------------------- |
| `questTitle`         | Quest title, a snapshot at Event time.                                        |
| `actorRole`          | `HIRER` or `WORKER`: the role of the recipient in the Quest.                  |
| `cancellationReason` | `HIRER_CANCELLED`, `HIRER_NO_DECISION`, `WORKER_DECLINED`, `CONSENT_TIMEOUT`. |
| `failureReason`      | `PROOF_NOT_APPROVED`, `COMPLETION_NOT_APPROVED`, `DUE_AT_MISSED`.             |
| `assignmentId`       | The Assignment of the Event.                                                  |
| `disputeCaseId`      | The Dispute Case of a `DISPUTE` item.                                         |
| `disputeStatus`      | The Dispute Case status at Event time.                                        |
| `viewerWon`          | Boolean on `DISPUTE_CASE_DECIDED`: whether the recipient won.                 |

- An item never holds the reporter, the filed reason, proof, Message text, an amount, or data of the other party.
- `GET /api/v1/notifications/unread-count` returns `{ count, byCategory }`.
- `POST /api/v1/notifications/read` marks items read. The body is `{ ids }` (1 to 100 IDs) or `{ all: true }`. `category` is allowed only with `all`. The command is idempotent: a second call keeps the first `readAt`. An ID that belongs to another Member is ignored.
- `POST /api/v1/notifications/dismiss` hides items. The body is `{ ids }` (1 to 100 IDs). It is idempotent and also marks the items read. A penalty item cannot be dismissed (`400 NOTIFICATION_NOT_DISMISSABLE`). Dismiss hides an item and does not delete it. Penalty items stay as the audit trail.
- **Expired window**: An expired `*_PENDING` item stays unread. The client uses `expiresAt`. The Server does not mark it read.
- **Localization**: The Server sends codes and no localized text. The client builds text from the codes.
- **Realtime**: `GET /api/v1/notifications/events` is a WebSocket with the same Origin and Cookie rules as `/api/v1/wallet/events`. On connect the Server sends one `{ "type": "SUBSCRIBED", "version": 1 }` frame, as the other Member sockets do. Then the only change frame is `{ "type": "NOTIFICATIONS_CHANGED" }`, with no payload. The Server sends no heartbeat ping. The Server publishes it after commit when it creates a row. The client refetches the count and the first page.
- **Banned Members**: The inbox routes and the events socket skip the ban guard. A banned Member with an existing session reads the own inbox (`200`). Every other route keeps `403 MEMBER_BANNED`. New sign-in stays denied. A ban does not revoke an existing session today, so a signed-out Member (for example a permanent ban) cannot read the row. The public ban-status route is not built.

## Audit and retention

- An **Audit Record** stores actor or system, time, old value, new value, and reason where applicable.
- **Coverage**: Quest, Assignment, Proof Submission, Completion Confirmation, Admin Review Item, Quest Reward, Platform Fee changes, Candidate Inquiry Conversation creation, Message access, and `INQUIRY_CLOSED` transitions.
- Detailed Audit Records are visible only to authorized roles such as Hirer and Admin.
- Review creation and edits are recorded with the Review author and timestamp.
- **Retention**: Audit Records are retained for at least one year after the Quest becomes Terminal and longer when a Report Case requires a hold.
