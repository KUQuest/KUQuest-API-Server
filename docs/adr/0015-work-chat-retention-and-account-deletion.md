# Retain Work Chat with moderation holds and sender anonymization

Work Chat history and files remain available until their retention eligibility
time. `latestTerminalAt` is the Quest's latest terminal transition, and
`caseClosedAt` is set when a Report Case changes to `REPORT_CASE_DISMISSED` or
`REPORT_CASE_RESTORED`. `REPORT_CASE_PENDING` and `REPORT_CASE_HIDDEN` cases
remain open and continue to hold the Message and Attachment records named by
their Evidence References. One Message can carry more than one Report Case
(`docs/rulebook/admin/admin-rulebook.md` §5), so `caseClosedAt` is the close time of the
most recently closed one, and a Message with any open case has no `eligibleAt`
yet. After a case closes:

~~~text
eligibleAt = max(latestTerminalAt + 1 year, caseClosedAt + 90 days)
~~~

Without a Report Case, `eligibleAt` is `latestTerminalAt + 1 year`. Member
deletion anonymizes the sender while retaining the minimum identity linkage
needed by an open case. This keeps the coordination history and moderation
evidence auditable without retaining personal identity longer than the policy
allows.

For the MVP, a Terminal Quest is final and cannot reopen. BE-118, BE-120, and
BE-131 must not require or implement Terminal Quest reopening. If a future
product decision adds reopening, the Quest, Chat, and retention contracts and
their ADRs must be revised together before implementation.

Production activation requires confirmation of the one-year period against
university policy.

Closed Candidate Inquiry Conversation history and files follow the same
retention and moderation-hold policy. Closing removes Member access and normal
UI visibility; it does not require physical deletion at the assignment
transition.

Status: accepted.
