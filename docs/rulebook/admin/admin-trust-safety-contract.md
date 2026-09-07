# Admin Trust & Safety Contract

Part of the [Admin Rulebook](admin-rulebook.md). Defines accepted policy for message moderation, Report Cases, Evidence References, and moderation decisions.

## Scope

- Applies to Messages in both Work Conversations and Candidate Inquiry Conversations.
- Any Member who may read a Message (including a Departed Worker reading history inside their Membership Window) may create one Reporter Entry for it.
- **Reason**: A Reporter Entry carries `REPORT_ABUSIVE_OR_HARASSMENT` (abusive language or harassment) plus optional free-text detail. Quest conduct complaints open Conduct Reports under [Admin Conduct Report Contract](admin-conduct-report-contract.md).

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

Every decision requires a reason and creates an immutable Moderation Decision. `REPORT_CASE_HIDDEN` notifies the sender via System Message (if conversation open) or Android Push (if conversation closed).

## Retention

Retention follows `docs/adr/0015-work-chat-retention-and-account-deletion.md`:
`eligibleAt = max(latestTerminalAt + 1 year, caseClosedAt + 90 days)`. A Message with an open Report Case has no `eligibleAt` and is held indefinitely.
