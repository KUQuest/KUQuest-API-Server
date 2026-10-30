# Admin Trust & Safety Contract

Part of the [Admin Rulebook](admin-rulebook.md). Defines accepted policy for message moderation, Report Cases, Evidence References, and moderation decisions.

## Scope

- Applies to Messages in both Work Conversations and Candidate Inquiry Conversations.
- Any Member who may read a Message (including a Departed Worker reading history inside their Membership Window) may create one Reporter Entry for it.
- **Reason**: A Reporter Entry carries one of `REPORT_ABUSIVE_OR_HARASSMENT`, `REPORT_SPAM`, `REPORT_INAPPROPRIATE_CONTENT`, `REPORT_DANGER_OR_THREAT`, or `REPORT_OTHER`, plus optional free-text detail. Quest conduct complaints open Conduct Reports under [Admin Conduct Report Contract](admin-conduct-report-contract.md).

## Report Case lifecycle

- The first Reporter Entry for a Message creates its Report Case as `REPORT_CASE_PENDING`.
- Subsequent Reporter Entries for the same Message while its case is `REPORT_CASE_PENDING` or `REPORT_CASE_HIDDEN` attach to that same open case.
- A Reporter Entry on a Message whose most recent Report Case is `REPORT_CASE_DISMISSED` or `REPORT_CASE_RESTORED` (closed) creates a **new** Report Case, starting a fresh `REPORT_CASE_PENDING` round. It never reopens the closed case.

## Admin access boundaries

- Admin may read a Message's content and Attachments **only** through the Evidence Reference of a Report Case that names it. Admin has no general browse access to Work Chat or Candidate Inquiry Conversations.
- Every Admin read of evidence is recorded as an immutable **Admin Action**.

## Decisions and strike linkage

Admin resolves a `REPORT_CASE_PENDING` case, or re-evaluates a `REPORT_CASE_HIDDEN` case, with one of:

- `REPORT_CASE_DISMISSED`: No change to Message; case closes.
- `REPORT_CASE_HIDDEN`: Message and Attachments become invisible to participants (except sender and Admin); case remains open at `REPORT_CASE_HIDDEN`. **Creates a confirmed violation strike on the Misconduct ladder** (see [Admin Member Penalty Contract](admin-member-penalty-contract.md)).
- `REPORT_CASE_RESTORED`: Valid only from `REPORT_CASE_HIDDEN`; restores Message visibility; case closes. **Reverses the strike created by the earlier hide decision**.

Every decision requires an action-specific controlled reason code and creates an immutable Moderation Decision. `REPORT_CASE_HIDDEN` notifies the sender via System Message (if conversation open) or Android Push (if conversation closed). A decision note is not included in that notification.

## Persistence boundary

The Admin schema persists these Trust & Safety records:

- A Report Case points to one Message, stores the prefixed status and `caseClosedAt`, and permits at most one open case for that Message. Its generated public sequence is exposed by Admin APIs as a stable `RPT-######` display ID; the UUID remains the internal identifier.
- A Reporter Entry points to its Report Case and Message, stores the Member reporter, one of the five Message report reasons, and optional detail. The database allows at most one entry for one Member and one Message.
- An Evidence Reference points to one Message or one Attachment. It does not copy Message text, file bytes, or signed URLs. Report Case and evidence references use restrictive deletion rules so open evidence is not removed by an ordinary domain delete.
- A Moderation Decision stores the previous and new Report Case status, the Admin, the versioned controlled reason code, and the decision time. The database accepts only documented Report Case transitions.

The application remains responsible for checking the actor's Chat visibility,
case-scoping Attachment references, writing the matching Admin Action, and
updating the Message and Attachment visibility atomically with a decision.
Admin Action reason catalog version `2` defines action-specific Report Case codes:

- `REPORT_CASE_DISMISS`: `REPORT_NO_POLICY_VIOLATION`, `REPORT_INSUFFICIENT_EVIDENCE`, or `REPORT_CONTEXT_SUPPORTS_MESSAGE`.
- `REPORT_CASE_HIDE`: `REPORT_HARASSMENT_CONFIRMED`, `REPORT_SPAM_CONFIRMED`, `REPORT_THREAT_CONFIRMED`, `REPORT_INAPPROPRIATE_CONTENT_CONFIRMED`, or `REPORT_OTHER_POLICY_VIOLATION_CONFIRMED`.
- `REPORT_CASE_RESTORE`: `REPORT_MESSAGE_COMPLIES_WITH_POLICY`, `REPORT_CONTEXT_WAS_MISUNDERSTOOD`, or `REPORT_NEW_EVIDENCE_OVERTURNS_HIDE`.

Version-1 Admin Actions remain readable with their recorded catalog version and reason code. An Admin may add an optional `decisionReasonText` of up to 200 characters. The note is stored separately on the immutable Admin Action and does not replace `reasonCode`.

## Retention

Retention follows `docs/adr/0015-work-chat-retention-and-account-deletion.md`:
`eligibleAt = max(latestTerminalAt + 1 year, caseClosedAt + 90 days)`. A Message with an open Report Case has no `eligibleAt` and is held indefinitely.
