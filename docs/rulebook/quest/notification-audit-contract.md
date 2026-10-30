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
- **Banned Members**: A banned Member cannot sign in and cannot reach the notification inbox. The Push is still sent to the Push Device. A client can show it, but the Member cannot open the inbox until the ban ends.

## Notification inbox contract

The notification inbox is a Member's server-side list of Member Penalty Notification Events. It lets a Member see an Event that the Push did not show, for example after the Member disabled a Push Device.

- **Content**: The inbox holds Events only. It does not hold Work Conversation messages or System Messages. Chat history stays in the Work Conversation.
- **Retention**: The Server keeps an inbox item for at least 90 days after `createdAt`.
- **Scope**: A Member reads and changes only that Member's items. Every route needs a signed-in session.
- `GET /api/v1/notifications` returns the Member's items, newest first.
  - Query: `cursor` (opaque), `limit` (1 to 50, default 20), `unreadOnly` (boolean).
  - Response: `items` and `nextCursor`. `nextCursor` is `null` on the last page.
  - Item: `id`, `type`, `createdAt`, `readAt` (`null` when unread), `questId` (always `null` for Member Penalty Notifications), `result`, and `expiresAt` (`null` for a permanent ban).
- `GET /api/v1/notifications/unread-count` returns `{ count }`.
- `POST /api/v1/notifications/read` marks items read. The body is `{ ids }` (1 to 100 IDs) or `{ all: true }`. The command is idempotent: a second call keeps the first `readAt`. An ID that belongs to another Member is ignored.
- **Localization**: The Server sends no localized text in the inbox. The client builds text from `type`, `result`, and `expiresAt`.
- **Banned Members**: Sign-in denial blocks inbox routes for a banned Member (`403 MEMBER_BANNED`).

The decisions for this inbox are in [ADR 0035](../../adr/0035-member-notification-inbox.md).

## Audit and retention

- An **Audit Record** stores actor or system, time, old value, new value, and reason where applicable.
- **Coverage**: Quest, Assignment, Proof Submission, Completion Confirmation, Admin Review Item, Quest Reward, Platform Fee changes, Candidate Inquiry Conversation creation, Message access, and `INQUIRY_CLOSED` transitions.
- Detailed Audit Records are visible only to authorized roles such as Hirer and Admin.
- Review creation and edits are recorded with the Review author and timestamp.
- **Retention**: Audit Records are retained for at least one year after the Quest becomes Terminal and longer when a Report Case requires a hold.
