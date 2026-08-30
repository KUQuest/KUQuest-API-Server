# Notification and Audit Contract

Part of the [Quest and Work Chat Rulebook](quest-work-chat-rulebook.md). Defines accepted policy for KU bot System Messages, Android FCM Push Notifications, and Audit Record retention.

## System Message contract

- System Messages are immutable and use standard Event templates.
- They appear in the Work Conversation as messages from KU bot.
- **Events covered**: Membership changes, Proof Submission, approval, non-approval, deadline failure, Quest completion, Quest failure, Quest cancellation, and Quest Edit outcomes.
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
  - Delivery state is recorded (`PUSH_DELIVERY_PENDING`, `PUSH_DELIVERY_DELIVERED`, `PUSH_DELIVERY_FAILED`, `PUSH_DELIVERY_DISABLED`).
  - Transient failures are retried. Invalid destinations end at `PUSH_DELIVERY_DISABLED`.
  - When the app is active in foreground, an in-app Popup replaces the duplicate Push.
- **Recipients**:
  - A new Message in a Work Conversation notifies every other current Accepted Participant, never the sender.
  - Directly affected Events notify the affected recipient. Quest-wide Events notify all current Accepted Participants.
- **Muting and critical events**:
  - A Member can mute non-critical Push per Quest.
  - Critical Events remain deliverable: approval, non-approval, missing work at `dueAt`, `QUEST_FAILED`, `QUEST_COMPLETED`, `QUEST_CANCELLED`, and Quest Edits requiring a response.
- **Privacy**: Push contains a short update and relevant link. It never contains private proof details or evidence.

## Audit and retention

- An **Audit Record** stores actor or system, time, old value, new value, and reason where applicable.
- **Coverage**: Quest, Assignment, Proof Submission, Admin Review Item, Quest Reward, Platform Fee changes, Candidate Inquiry Conversation creation, Message access, and `INQUIRY_CLOSED` transitions.
- Detailed Audit Records are visible only to authorized roles such as Hirer and Admin.
- Review creation and edits are recorded with the Review author and timestamp.
- **Retention**: Audit Records are retained for at least one year after the Quest becomes Terminal and longer when a Report Case requires a hold.
