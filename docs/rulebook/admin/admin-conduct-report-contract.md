# Admin Conduct Report Contract

Part of the [Admin Rulebook](admin-rulebook.md). Defines accepted policy for Quest conduct moderation, permitted report reasons, filing windows, decisions, and notifications.

## Scope and evidence distinction

A **Conduct Report** evaluates how a Member behaved on a Quest, supported by the **Quest record** (Assignment, Proof Submission, and timestamps). In contrast, a **Report Case** evaluates Message content in Chat (see [Admin Trust & Safety Contract](admin-trust-safety-contract.md)).

## Allowed reasons and relationships

| Filer &rarr; Reported | Reason | When allowed |
| --- | --- | --- |
| Hirer &rarr; Worker | `CONDUCT_ABANDONED` | In `SINGLE` and `GROUP + FCFS`, against a Worker who sent no Proof Submission and made no proof-free confirmation. In `GROUP + CANDIDATE`, against the **Team Leader only**, and only when no Team Proof Submission or confirmation was sent. |
| Worker &rarr; Hirer | `CONDUCT_OUT_OF_SCOPE` | Demanded work beyond Quest Condition, or commissioned dishonest/unlawful work. Allowed from `QUEST_ASSIGNED` through terminal completion. |
| Worker &rarr; Worker on same Quest | `CONDUCT_NO_SHOW` | `GROUP + FIRST_COME_FIRST_SERVED` only, against a Worker who sent no Proof Submission and made no confirmation. |

- Missing work at `dueAt` is `CONDUCT_ABANDONED`; late delivery does not exist because the Server rejects late submissions.
- Abusive language or harassment in Chat must be reported as a Report Case, not a Conduct Report.

## Filing rules and windows

- Only Members who held the stated role on that Quest may file.
- At most one Conduct Report per reported Member per Quest.
- **Filing window**: Opens when the Quest reaches `QUEST_ASSIGNED` and closes **1 day** after the Quest becomes Terminal.
- Filing moves no money and is not bounded by the 7-day money hold.

## Admin access and decision

- Admin reviews the named Quest record (Assignment, Proof Submission, and timestamps) and may access the Work Chat and Candidate Inquiry history of the reported Quest to evaluate context.
- Every Admin access to chat history during a Conduct Report review logs an immutable **`Admin Action`** entry.
- Admin resolves a `CONDUCT_REPORT_PENDING` report as:
  - `CONDUCT_REPORT_DISMISSED`: No violation; case closes.
  - `CONDUCT_REPORT_UPHELD`: Confirms a violation on the **Misconduct ladder** (see [Admin Member Penalty Contract](admin-member-penalty-contract.md)). Permanent strike; no restore path.
- Requires a reason and a non-blank `Idempotency-Key`.
- Decisions are final and create an Audit Record.

## Notifications and privacy

- `CONDUCT_REPORT_UPHELD` sends an Android Push Notification to the reported Member naming the reason and result.
- Filing and dismissals send no notification.
- The filer's identity is never revealed to the reported Member.

## Retention

Retained for **one year after the Quest becomes Terminal**.
