# Conversation Contracts

Part of the [Quest and Work Chat Rulebook](quest-work-chat-rulebook.md). Defines accepted policy for the two distinct Chat Conversation types in KUQuest: **Candidate Inquiry Conversation** (pre-assignment Q&A) and **Work Conversation** (active work coordination).

## Chat Types Overview and Comparison

| Attribute                       | Candidate Inquiry Conversation                                                                       | Work Conversation                                                                                          |
| ------------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| **Database `type`**             | `CONVERSATION_CANDIDATE_INQUIRY`                                                                     | `CONVERSATION_WORK`                                                                                        |
| **Purpose**                     | Pre-assignment Q&A: Prospective Workers clarify unclear Quest details with the Hirer.                | Active work coordination between the Hirer and assigned Workers.                                           |
| **Multiplicity per Quest**      | Many (at most one per Prospective Worker).                                                           | Exactly one per Quest.                                                                                     |
| **Participants**                | Strictly 2: Hirer + 1 Prospective Worker.                                                            | Hirer + all current Active Workers.                                                                        |
| **Active Quest State**          | Exclusively during `QUEST_OPEN`.                                                                     | From first `ASSIGNMENT_ACTIVE` through `QUEST_IN_PROGRESS` and terminal states.                            |
| **Lifecycle End**               | `INQUIRY_CLOSED` &rarr; Disappears completely from Member views upon assignment or quest assignment. | Terminal states (`COMPLETED`/`FAILED`/`CANCELLED`) &rarr; Becomes permanent read-only archive for members. |
| **History Migration**           | Never transferred or copied to Work Conversation.                                                    | Preserved in place for current/future accepted participants.                                               |
| **System Messages (KU bot)**    | None. (Human-to-human messages only).                                                                | Yes. KU bot posts immutable workflow event messages.                                                       |
| **Push Notifications**          | Notifies only the single other participant.                                                          | Notifies all other Accepted Participants.                                                                  |
| **Moderation (Trust & Safety)** | Covered: reported messages open Report Cases via Evidence References.                                | Covered: reported messages open Report Cases via Evidence References.                                      |

---

## Subsystem Relationships

### 1. Relation to Quest Lifecycle & Assignments

- **Opening Work Chat**: Triggered by the creation of the first `ASSIGNMENT_ACTIVE` Assignment in the database transaction.
- **Closing Inquiries**: Triggered atomically by Assignment creation (for the accepted Worker) and `QUEST_ASSIGNED` transition (for all remaining unselected inquiries).
- **State Independence**: Messaging in either conversation never directly alters Quest State or Assignment State.

### 2. Relation to System Messages and KU Bot

- Work Conversations host official KU bot System Messages (e.g. proof submission, edit consensus, deadline alerts, rating review links).
- Candidate Inquiry Conversations strictly prohibit System Messages to prevent leaking quest state or candidate identities.

### 3. Relation to Trust & Safety (Admin Moderation)

- Messages in **both** conversation types can be reported for abusive language or harassment (`REPORT_ABUSIVE_OR_HARASSMENT`).
- Admin access to chat content is strictly gated through Report Case **Evidence References**; Admins cannot browse conversations without an active/historical case.

---

## Candidate Inquiry Conversation

A Candidate Inquiry Conversation lets a Prospective Worker ask the Hirer questions to clarify unclear Quest details before becoming a Worker. It is available for every Quest while `QUEST_OPEN`, across all selection modes (`FIRST_COME_FIRST_SERVED` and `CANDIDATE`) and participation shapes (`SINGLE` and `GROUP`). It is private, one-to-one, and separate from the Work Conversation.

### Opening and access

- A Member who can view any `QUEST_OPEN` Quest may start one Candidate Inquiry Conversation with that Quest's Hirer. The Hirer cannot create a self-conversation.
- Availability by mode:
  - `FIRST_COME_FIRST_SERVED`: Prospective Worker clarifies details before deciding to join.
  - `CANDIDATE`: Prospective Worker or Candidate asks about requirements before applying, during team formation, or before selection.
- Starting a Conversation does not create an Assignment, change Quest State, or make the Member an Accepted Participant.
- Exactly two participants: the Hirer and the Prospective Worker. Other Members, Candidates, and Active Workers cannot read or send in it.
- Topics covered: visible Quest information (Quest Condition, `dueAt`, `proofRequired`, Quest Reward). Proof Submission is always a separate resource.
- Messages are not copied to the Work Conversation.

### Closing and disappearance

- A new Conversation starts as `INQUIRY_OPEN`.
- **Closing triggers**:
  1. Prospective Worker receives `ASSIGNMENT_ACTIVE` Assignment: closes immediately in the same transaction.
  2. Quest enters `QUEST_ASSIGNED`: Server closes every remaining `INQUIRY_OPEN` Conversation for that Quest in the same transaction.
  3. Quest is cancelled before assignment: Server closes every remaining `INQUIRY_OPEN` Conversation for that Quest.
- **Disappearance**: Closing sets `INQUIRY_CLOSED`. The Conversation disappears from normal Member inboxes and Quest pages. Members cannot list, read, send, or download its content.
- Closed history is not transferred to the Work Conversation. Physical retention follows Chat retention and moderation policy.
- Closing creates no workflow `System Message` in the Work Conversation.

### Notifications

- A new Message notifies only the other participant in that Candidate Inquiry Conversation.
- Active on-page users see Messages in place; otherwise it uses in-app Popup or Android Push.
- After `INQUIRY_CLOSED`, no new Message or notification is created.

---

## Work Conversation

A Work Conversation opens when the first Worker receives an `ASSIGNMENT_ACTIVE` Assignment. Quest creates the Conversation and adds the Hirer and that Worker in the same transaction; later Active Workers join the same Conversation.

### Opening and membership

- Type is `CONVERSATION_WORK`. At most one Work Conversation per Quest.
- Members: Hirer and current Active Workers. Candidates and Prospective Workers never join.
- A newly accepted Worker can read retained history and receive new Messages from membership start.
- A Worker who leaves can read only Messages created no later than departure and cannot send or receive new Messages.
- When a Quest becomes Terminal (`QUEST_COMPLETED`, `QUEST_CANCELLED`, `QUEST_FAILED`), the Work Conversation remains readable but becomes read-only for Members. The system may append later workflow System Messages.

### Messages and attachments

- Message text is optional only when an Attachment is present, and is at most 1,000 characters.
- A Message may contain any number of Attachments. Each file is at most 10 MB (image, PDF, video). Files are not malware-scanned.
- Sent Messages cannot be edited, deleted, replied to, or reacted to.
- No Message search, typing indicator, online status, or Member-visible Read Receipt exists.
- Older Messages appear above newer Messages. Server acceptance time defines the order. The UI loads 50 newest Messages first.
- Attachment downloads use temporary links valid for 15 minutes.
- If a send fails, the sender sees the failure and can retry. A retry cannot create duplicate Messages.

### Read cursor and UI

- Opening the page advances the Member's private `Read Cursor` to the last displayed Message.
- A Member sees only that Member's unread count and cannot see another Member's Read Cursor.
- The participant list shows each participant's name and role.

### Rate limits

Per Member per Quest:

- at most 30 Chat Messages per minute;
- at most 10 Chat Attachments per minute.

When limited, the UI shows the remaining wait time and preserves the Message or Attachment being prepared.
