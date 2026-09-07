# Hold Quest-failure settlement for the Dispute Case window

When a Quest becomes `QUEST_FAILED`, the amount the Reward and money
contract returns to the Hirer is held for 7 days — not released as ordinary
Spending Balance immediately — so that money is still available if a
Dispute Case later redirects some of it back to a Worker (see
`docs/rulebook/admin/admin-rulebook.md` §2). Without a hold, a Hirer could spend or
withdraw the returned amount before a same-Quest Dispute Case is decided,
leaving no funds for the reversing Ledger Transaction to draw from.

The hold is not a new Wallet balance. It is the Quest's own Funding
Reservation kept `ACTIVE` for 7 more days, with the returned amount left as
its `remainingSatang`. This keeps ADR 0009 true — the Quest module owns the
timing while the Wallet keeps a generic Funding Reservation — and it adds no
column to the Wallet, whose four balances (`SPENDING`, `EARNINGS`,
`FUNDING_RESERVED`, `RESERVED_FOR_PAYOUTS`) stay as they are. The release at
day 7 is an ordinary `FUNDING_RELEASE`.

The whole returned amount is held, including the Platform Fee that a failed
Quest returns to the Hirer. Splitting the reservation to release the fee
early adds machinery for no product gain.

Two payments draw on this reservation, not only a Dispute Case. A Hirer may
approve a still-`PROOF_PENDING` Proof Submission after the Quest failed
(`docs/rulebook/quest/quest-work-chat-rulebook.md` §Failure and partial success), and
that Worker's Reward settles from this same reservation. Because a pending
Proof Submission becomes `PROOF_APPROVED` automatically 24 hours after it is
sent, that payment always falls inside the 7-day hold.

The hold releases automatically and unconditionally at 7 days, whether or
not a Dispute Case for that Quest is still `DISPUTE_CASE_PENDING`. A
Dispute Case decided after the hold releases can still redirect funds if
the Hirer's Spending Balance happens to have enough at that time; if not,
the transfer fails. This is a deliberate simplicity trade-off: extending
the hold for every still-open case avoids that failure mode, but adds an
unbounded hold duration tied to Admin response time.

To keep that trade-off honest, both windows for opening a Dispute Case close
before the hold does. Self-filing is capped at 1 day, and an Admin may open a
case on a Worker's behalf up to 5 days. Every case therefore has at least 2
days of held money in which to be decided, so an unresolved case at day 7 is
expected to be rare.

The code this decision needs — keeping the reservation `ACTIVE` and
releasing it at day 7 — is listed in `docs/reconciliation/admin-reconciliation.md`
§Migration and implementation checklist.

Status: accepted.
