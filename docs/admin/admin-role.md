# Admin Role

Status: accepted product target, 2026-08-30.

This document is the target behavior for everything an Admin does: Payout
Approval, Dispute Case, Quest Hide, Wallet Freeze/Suspend, Trust & Safety
moderation, and the Member penalty ladders. Use it when a task changes any of
those areas.

## Read first

1. Read the root `CONTEXT.md` for the canonical vocabulary, then use this
   document for the settled behavior.
2. Read `docs/adr/0022-manual-admin-approval-for-payouts.md`,
   `docs/adr/0010-retain-and-correct-financial-records.md`,
   `docs/adr/0014-work-chat-is-server-readable-for-moderation.md`,
   `docs/adr/0015-work-chat-retention-and-account-deletion.md`, and
   `docs/adr/0024-hold-quest-failure-settlement-for-dispute-window.md`.
3. Treat this document as the target contract for Admin behavior, alongside
   `docs/quest/work-chat-system-target.md` for Quest/Chat behavior. Where the
   two overlap (Dispute Case, Trust & Safety), this document is authoritative
   for the Admin-facing rule and the other document is authoritative for the
   Quest/Chat-facing rule. One rule crosses that line on purpose: the 7-day
   money hold in §2 delays the return that
   `work-chat-system-target.md` §Reward and money contract describes as
   "unpaid Worker-slot Rewards return to the Hirer". The amount and the
   recipient do not change; only the moment the Hirer can spend it moves.
   This document and ADR 0024 are authoritative for that timing.
4. This document consolidates and, where flagged, newly resolves several
   areas that were previously only terms in `CONTEXT.md` or explicitly
   deferred (Dispute Case, Quest Hide, Wallet Freeze/Suspend, Trust & Safety,
   Member Ban). It does not silently invent behavior beyond what a grilling
   session on 2026-08-30 actually settled — unresolved points are listed in
   [Known gaps](#known-gaps).

## Scope

Admin has seven areas of responsibility:

- **Payout Approval** — approve or reject a Student's submitted Payout.
- **Dispute Case** — reverse part of a `QUEST_FAILED` settlement between a
  Hirer and a Worker.
- **Quest Hide** — remove a Quest from discovery without affecting its
  workflow.
- **Wallet Freeze/Suspend** — hold a Student's Wallet against new
  commitments.
- **Trust & Safety** — moderate reported Work Chat and Candidate Inquiry
  Conversation Messages.
- **Conduct Report** — review a report about how a Member behaved on a Quest,
  where the evidence is the Quest record rather than a Message.
- **Member Ban** — apply the Misconduct and low-average-review penalty
  ladders, up to a permanent ban.

Admin currently has one undifferentiated permission tier: `authAdmin` has no
role or permission-level column, only `disabledAt` (self-disable by another
Admin is out of scope — see [Known gaps](#known-gaps)). Every enabled Admin
may perform every action in this document.

## State and status naming

Follows the entity-prefix convention from
`work-chat-system-target.md` §State and status naming.

| Object | Field | Allowed values |
| --- | --- | --- |
| Dispute Case | status | `DISPUTE_CASE_PENDING`, `DISPUTE_CASE_DISMISSED`, `DISPUTE_CASE_RESOLVED` |
| Report Case | status | `REPORT_CASE_PENDING`, `REPORT_CASE_DISMISSED`, `REPORT_CASE_HIDDEN`, `REPORT_CASE_RESTORED` |
| Conduct Report | status | `CONDUCT_REPORT_PENDING`, `CONDUCT_REPORT_UPHELD`, `CONDUCT_REPORT_DISMISSED` |
| Payout | status | `PENDING_ADMIN_APPROVAL` and the existing provider-processing statuses (ADR 0022; unchanged by this document) |

Two existing enums are cited as-is, not renamed, because they are live in a
migrated database:

- Wallet `walletStatus`: `ACTIVE`, `FROZEN`, `SUSPENDED`, `CLOSED`
  (`wallet.schema.ts`). These are not entity-prefixed, unlike the table
  above — see [Known conflicts](#known-conflicts).
- `CONTEXT.md`'s Report Case entry previously listed bare `PENDING` /
  `DISMISSED` / `HIDDEN` / `RESTORED` values. This document corrects them to
  the prefixed values above; `CONTEXT.md` is updated to match.

Member Ban state is not an enum at all. `memberPenaltyRecord` holds the
strikes and is the source of truth; `bannedUntil` and `redFlagExpiresAt`
project the current expiry for a guard to read in one lookup — see
[§6 Member Ban and penalty ladders](#6-member-ban-and-penalty-ladders).

## 1. Payout Approval

Fully specified by `docs/adr/0022-manual-admin-approval-for-payouts.md` and
already implemented (`payout.admin.route.ts`/`.controller.ts`/`.service.ts`).
This document does not change that behavior. See the ADR for the complete
rule: `PENDING_ADMIN_APPROVAL` queue, approve/reject, Idempotency-Key,
masked destination display, and the Payout worker hand-off.

## 2. Dispute Case

Reverses part of the automatic settlement a `QUEST_FAILED` Quest already
applied (unpaid Worker-slot Rewards returning to the Hirer — see
`work-chat-system-target.md` §Reward and money contract), when that
settlement was unfair to a specific Worker.

### Structural constraints

- A Quest may have more than one Dispute Case, at most one per filer. A
  filer is the Hirer, or a Worker who held an Assignment on that Quest.
- Every Dispute Case for a Quest shares one cap: the total Satang redirected
  across all of that Quest's Dispute Cases must never exceed what remains in
  that Quest's held Funding Reservation. The cap starts as the amount
  returned to that Quest's Hirer at failure settlement, and shrinks if a
  post-failure Proof approval settles a Reward from the same reservation
  first (see [Money hold](#money-hold)).
- Money moves in one direction only: Hirer → Worker. A Dispute Case can
  never reclaim a Reward already transferred directly to a Worker before the
  Quest failed — that stays governed by the existing "Already transferred
  Rewards are not reclaimed" rule.

### Opening a Dispute Case

- The Hirer, or any Worker who held an Assignment on the Quest, may open one
  Dispute Case for themselves within **1 day** of the Quest becoming
  `QUEST_FAILED`.
- An Admin may open one Dispute Case on behalf of any Worker who held an
  Assignment on the Quest, within **5 days** of the Quest becoming
  `QUEST_FAILED` — later than the 1-day self-file window, because an Admin may
  not reach the case in time, but earlier than the 7-day money hold, so every
  Admin-opened case still has at least 2 days to be decided while the money is
  held. An Admin-opened case counts toward the same per-Quest cap as a
  self-filed one.
- An Admin needs no Admin Review Item to open a case. A linked Admin Review
  Item (`work-chat-system-target.md` §Review and decision) is one way an Admin
  learns that a case is warranted, but it is not a precondition: a Quest that
  failed from a missing Start Work or a missing Proof Submission creates no
  Admin Review Item, and its Workers still need an Admin route.
- An Admin Review Item is not itself a Dispute Case, and reviewing one is
  optional and separate from a Worker or Hirer's own right to self-file
  within the 1-day window.

### Money hold

- When a Quest becomes `QUEST_FAILED`, the amount the Reward and money
  contract returns to the Hirer is placed in a **7-day hold** — not usable
  as ordinary Spending Balance — instead of being released immediately.
- The hold is the Quest's own Funding Reservation kept `ACTIVE` for 7 more
  days, with the returned amount left as its `remainingSatang`. It is not a
  new Wallet balance bucket. This keeps ADR 0009 true: the Quest owns the
  timing and the Wallet keeps a generic Funding Reservation.
- The whole returned amount is held, including the Platform Fee that a failed
  Quest returns to the Hirer. The reservation is not split.
- A Reward the Hirer approves after `QUEST_FAILED` — the post-failure review
  of a still-`PROOF_PENDING` Proof Submission in
  `work-chat-system-target.md` §Failure and partial success — settles from
  this same reservation, not from the Hirer's Spending Balance.
- The hold releases automatically and unconditionally 7 days after
  `QUEST_FAILED`, whether or not a Dispute Case is still `DISPUTE_CASE_PENDING`
  at that moment. A Dispute Case resolved after the hold releases may still
  redirect funds if the Hirer's Spending Balance has enough at decision
  time; if it does not, the transfer fails (see [Known gaps](#known-gaps) —
  this is an accepted risk, not designed around further). See
  `docs/adr/0024-hold-quest-failure-settlement-for-dispute-window.md`.

### Decision

- Admin resolves a Dispute Case as:
  - `DISPUTE_CASE_DISMISSED` — no change.
  - `DISPUTE_CASE_RESOLVED` — an explicit positive Satang amount is
    redirected to the named Worker's Earnings Balance, recorded as a
    reversing Ledger Transaction per ADR 0010. While the money hold is still
    running, the amount comes out of the Quest's held Funding Reservation.
    After the hold has released, it comes out of the Hirer's Spending
    Balance, and the transfer fails if that balance is too small.
- Requires a non-blank `Idempotency-Key`. A matching retry replays the
  original decision; reusing the key for a different Dispute Case conflicts.
- The first confirmed decision for a Dispute Case is final.
- A non-active Hirer Wallet does not block the redirect. It reconciles a
  commitment already in progress, which `CONTEXT.md` §Wallet Status already
  permits for a `FROZEN`, `SUSPENDED`, or `CLOSED` Wallet.
- Every decision creates an Audit Record (actor, time, previous value, new
  value, reason).

## 3. Quest Hide

- Admin may hide a Quest in any non-terminal state (`QUEST_OPEN`,
  `QUEST_ASSIGNED`, `QUEST_IN_PROGRESS`), using the existing
  `hiddenAt`/`hiddenByAdminId` schema fields (`quest.schema.ts`) — this
  document is the first specified use of that field.
- `hiddenAt` is an independent flag. Hiding never writes a Quest State value.
  The legacy `QUEST_HIDDEN` enum value, and the database CHECK that ties it to
  `hiddenAt`, must both go (see [Known conflicts](#known-conflicts)), because
  `work-chat-system-target.md` §State and status naming allows exactly seven
  Quest States and `QUEST_HIDDEN` is not one of them.
- Hiding removes the Quest from Quest search and discovery **only**.
  Every other rule in `work-chat-system-target.md` — `dueAt`, Start Work,
  Proof Submission, Quest Edit, settlement, Work Conversation access —
  applies unchanged while a Quest is hidden.
- The Hirer still sees and manages their own hidden Quest normally, marked
  hidden in their own view. Current Accepted Participants are unaffected.
- Hiding requires a non-empty reason and a non-blank `Idempotency-Key`.
  Restoring does not require a reason but does require an `Idempotency-Key`.
- There is no automatic expiry; a hidden Quest stays hidden until an Admin
  restores it. A Quest may be hidden and restored any number of times; each
  action is independently reasoned and creates an Audit Record.
- Hiding sends a Push Notification to the Hirer stating the Quest was hidden
  and why. Restoring sends one too. It is not a System Message: a
  `QUEST_OPEN` Quest has no Work Conversation yet, because
  `work-chat-system-target.md` opens one only at the first
  `ASSIGNMENT_ACTIVE` Assignment. The hidden marker in the Hirer's own Quest
  view (above) stays available when Android Push permission is off.
- Hide and restore never change Quest Escrow, Assignment state, or any
  money.

## 4. Wallet Freeze/Suspend

- Admin may set a Student's Wallet to `FROZEN` or `SUSPENDED`
  (`wallet.schema.ts`'s existing `walletStatus` values). Both require a
  non-empty reason and a non-blank `Idempotency-Key`.
- A non-active Wallet (`FROZEN`, `SUSPENDED`, or `CLOSED`) blocks that
  Student from **starting** any new commitment: Top-up, Payout request,
  Earnings Conversion, publishing a new Quest, joining or applying to any
  Quest as a Worker or Candidate, and creating a Candidate Team.
- Every commitment that already existed before the hold began — a Quest
  Escrow already reserved, an Assignment already active, a Payout already
  `PENDING_ADMIN_APPROVAL` or later — continues to completion under its own
  existing rules, unaffected by the Wallet's status. This is the existing
  `CONTEXT.md` Wallet Status rule: "Non-active Wallets still receive or
  release money required to reconcile commitments already in progress,"
  unchanged by this document.
- `FROZEN` and `SUSPENDED` block the same set of new operations. They differ
  only in intent — Freeze implies a temporary hold pending investigation,
  Suspend implies a hold that requires explicit Admin review before
  lifting — not in what they block.
- There is no enumerated list of triggers; an Admin applies Freeze/Suspend
  at their own discretion, recording the reason.
- An Admin lifts a discretionary hold by explicitly returning the Wallet to
  `ACTIVE`. There is no automatic expiry and no other intermediate status.
- One exception: a Freeze applied automatically by a temporary Member Ban
  (§6) is not discretionary. It returns to `ACTIVE` in the same action that
  ends that ban, with no Admin step. A Freeze an Admin applied on their own
  is never lifted by a ban expiring.

## 5. Trust & Safety

Uses `CONTEXT.md`'s existing Report Case, Reporter Entry, Evidence
Reference, Moderation Decision, and Admin Action definitions, with the
status values corrected to the prefixed form in
[State and status naming](#state-and-status-naming).

### Scope

- Applies to Messages in both the Work Conversation and the Candidate
  Inquiry Conversation.
- Any Member who may read a Message may create one Reporter Entry for it.
  This includes a Departed Worker reading history inside that Worker's Work
  Membership Window, not only current Accepted Participants.
- A Reporter Entry carries one fixed reason,
  `REPORT_ABUSIVE_OR_HARASSMENT` (abusive language or harassment), plus
  optional free-text detail. This matches `CONTEXT.md`'s Reporter Entry
  definition, "a Member's reason and optional detail". Every other reason in
  the product's report list is Quest conduct and opens a Conduct Report
  under §7 instead.

### Report Case lifecycle

- The first Reporter Entry for a Message creates its Report Case as
  `REPORT_CASE_PENDING`. Later Reporter Entries for the same Message, while
  its Report Case is `REPORT_CASE_PENDING` or `REPORT_CASE_HIDDEN`, attach to
  that same open case.
- A Reporter Entry on a Message whose most recent Report Case is
  `REPORT_CASE_DISMISSED` or `REPORT_CASE_RESTORED` (closed) creates a **new**
  Report Case, starting a fresh `REPORT_CASE_PENDING` round. It never reopens
  the closed case.

### Admin access

- Admin may read a Message's content and Attachments **only** through the
  Evidence Reference of a Report Case that names it. Admin has no general
  browse access to Work Chat or Candidate Inquiry Conversation content
  outside an open or historical Report Case.
- Every Admin read of evidence is recorded as an Admin Action, per
  `CONTEXT.md`'s existing definition — separate from the broader Audit
  Record that covers the Moderation Decision itself.

### Decision

Admin resolves a `REPORT_CASE_PENDING` Report Case, or reopens a
`REPORT_CASE_HIDDEN` one, with exactly one of:

- `REPORT_CASE_DISMISSED` — no change to the Message; the case closes.
- `REPORT_CASE_HIDDEN` — the Message and its Attachments become invisible
  to every participant except the sender and Admin; the case stays open at
  `REPORT_CASE_HIDDEN`.
- `REPORT_CASE_RESTORED` — valid only from `REPORT_CASE_HIDDEN`; makes the
  Message visible to every participant again; the case closes.

Every decision is an immutable Moderation Decision and requires a reason.
`REPORT_CASE_HIDDEN` tells the sender that the Message was hidden and why. It
uses a System Message while the Message's Conversation is still open, and a
Push Notification once that Conversation has closed, because
`work-chat-system-target.md` §Closing and disappearance creates no new
Message in an `INQUIRY_CLOSED` Candidate Inquiry Conversation. No other
participant is notified beyond simply no longer seeing the Message.

### Retention

Unchanged from `docs/adr/0015-work-chat-retention-and-account-deletion.md`:
`eligibleAt = max(latestTerminalAt + 1 year, caseClosedAt + 90 days)`. Because
§Report Case lifecycle lets one Message carry more than one Report Case,
`caseClosedAt` is the close time of the most recently closed one. A Message
with any open case has no `eligibleAt` yet.

## 6. Member Ban and penalty ladders

Two independent ladders. A Member's strike count on one never affects the
other.

"An Admin confirms a violation", the trigger for the ladder below, means
either of two Admin decisions naming this Member as the offender:

- a `REPORT_CASE_HIDDEN` Moderation Decision on a Message this Member sent
  (§5); or
- a `CONDUCT_REPORT_UPHELD` decision on a Conduct Report filed against this
  Member (§7).

Both feed one sequence. A Member with one of each is on their 2nd strike.

### Misconduct ladder

| Confirmed-violation count | Result | Duration |
| --- | --- | --- |
| 1st | Red Flag | 7 days (`PC-09`) |
| 2nd | Temporary ban | 7 days (`PC-11`) |
| 3rd | Permanent ban | — |

- **Red Flag**: visible on the Member's Profile, on the mini-profile a Hirer
  sees during Candidate selection, and on the Hirer identity a Prospective
  Worker sees on a Quest. While flagged, the Member cannot apply as a
  Candidate, join a `FIRST_COME_FIRST_SERVED` Quest, **or publish a new
  Quest**. It restricts both sides, because `CONDUCT_OUT_OF_SCOPE` (§7) names
  a Hirer as the offender, and a flag that only blocked Worker-side actions
  would leave that Member's first strike with no effect at all. A Quest the
  Member published before being flagged runs to its end unchanged. Expires
  automatically 7 days after being set — no Admin action needed to clear
  it.
- The same constants table carries `PC-10`, a Red Flag for a Worker who
  cancels their own Quest. It is **dropped**: an Active Worker cannot
  voluntarily leave a Quest (`work-chat-system-target.md` §Cancellation), so
  `PC-10` has no trigger to fire on.
- **Temporary ban** (2nd strike): the Member cannot sign in for 7 days. On
  expiry, sign-in resumes; this does not also set a Red Flag.
- **Permanent ban** (3rd strike): the Member can never sign in again. There
  is no `disabledAt` column on `auth_user`; only `auth_admin` has one. A
  permanent ban is read from `memberPenaltyRecord` instead: the Member is
  permanently banned while that table holds a row whose result is the
  permanent tier. This follows the same rule as the strike counts below,
  where the immutable audit table is the source of truth rather than a
  mutable column (ADR 0006, ADR 0010). `bannedUntil` carries temporary bans
  only and never receives a far-future sentinel value (see
  [Known conflicts](#known-conflicts)).
- **Reversal**: a `REPORT_CASE_RESTORED` decision cancels the strike that its
  earlier `REPORT_CASE_HIDDEN` decision created. Only a `REPORT_CASE` source
  strike can be reversed; a `CONDUCT_REPORT` one cannot (§7). Cancelling writes a linked
  reversing row in `memberPenaltyRecord` instead of deleting the original, the
  same correction pattern ADR 0010 requires for financial records, and clears
  any Red Flag or ban that strike produced at once. A stored sequence number
  records creation order and is never rewritten; the ladder position is
  counted at read time over the rows that carry no reversal.
- **Exemptions**: a Member's first 10 (`PC-12`) confirmed violations after
  account creation, and first 3 (`PC-13`) confirmed violations after a
  temporary or permanent ban lifts, do not advance this ladder or trigger
  any result. `PC-09` to `PC-13` come from a penalty-constants table held
  outside this repository; these values were confirmed against it on
  2026-08-30. A Member's first result therefore arrives at confirmed
  violation 11, and the permanent tier at 13.
- Banning a Member (2nd or 3rd strike) **auto-freezes** that Member's Wallet
  in the same action (§4). When a temporary ban expires, the same mechanism
  returns that Wallet to `ACTIVE` automatically (§4).
- An Assignment the Member holds when banned is **not** force-ended; the
  Quest's existing `dueAt`/Start Work deadline rules apply unchanged. A
  banned Worker who cannot sign in to act simply misses those deadlines and
  fails the Assignment through the existing rule, not a new ban-specific
  cascade.

### Low-average-review ladder

| Violation count | Result | Duration |
| --- | --- | --- |
| 1st | Temporary ban | 7 days |
| 2nd | Temporary ban | 1 month |
| 3rd | Permanent ban | — |

- Triggers only once a Member has received at least **10 Reviews**. From
  the 10th Review onward, every time a newly received Review causes the
  Member's running average rating to cross from ≥3.0 down to below 3.0,
  that crossing counts as one violation.
- The count does not increment again for further Reviews received while the
  average is already below 3.0. A new violation is counted only the next
  time the average crosses downward through 3.0 again — i.e. after
  recovering to ≥3.0 in between.
- This ladder is **fully automatic** — a system evaluation, not an Admin
  decision, creates each strike. Unlike the ladder above, no Admin action
  triggers it; Admin's role here is limited to visibility (e.g. for support
  or an appeal), not the decision.
- `PC-12` and `PC-13` do not apply to this ladder. They count confirmed
  violations on the Misconduct ladder, while this ladder counts downward
  crossings of the 3.0 average.
  The two units do not map onto each other.
- The average is one running average over every Review the Member received,
  in both the Hirer and the Worker direction. There is no separate per-role
  average.
- The ladder evaluates only when a Review is created. A Review edited inside
  its 7-day edit window changes the displayed average but never cancels,
  creates, or re-sequences a strike already recorded.
- Its permanent tier uses the same `memberPenaltyRecord` rule as the
  Misconduct ladder, and its temporary-ban expiry is derived per ladder from
  that same table, independent of the Misconduct ladder's. A Member could be serving a
  temporary ban from both ladders at once; the later of the two expiry times
  governs actual sign-in denial.

### Data shape (not yet in schema)

- `authUser.bannedUntil` (nullable timestamp) — the later of the two ladders'
  temporary-ban expiries, projected from `memberPenaltyRecord` so the auth
  guard reads one value. It never holds two expiries; each ladder's own expiry
  is derived per ladder from that table. A new column: `auth_user` has no ban
  or disable column today.
- `authUser.redFlagExpiresAt` (nullable timestamp) — Red Flag expiry. Also a
  new column.
- A `memberPenaltyRecord` audit table: one immutable row per strike, on
  either ladder, recording the Member, ladder (`MISCONDUCT` | `REVIEW`),
  source (`REPORT_CASE` or `CONDUCT_REPORT` on the Misconduct ladder,
  `REVIEW_AVERAGE` on the other), sequence number, result, actor (the deciding
  Admin on the Misconduct ladder, `SYSTEM` on the Review ladder), reason,
  creation time, and a nullable link to the row this one reverses (see
  **Reversal** above). The source field is what lets an Admin answering an
  appeal say which decision produced a strike. Strike counts
  and exemption windows are derived by querying this table rather than a
  mutable counter column, consistent with this repo's existing preference
  for immutable audit trails (ADR 0006, ADR 0010) over denormalized
  counters as the source of truth. The permanent-ban tier of either ladder is
  read from this table too.

## 7. Conduct Report

A Conduct Report is about **how a Member behaved on one Quest**. A Report Case
(§5) is about **the content of one Message**. They are separate records
because their evidence is separate: a Report Case points at a Message through
an Evidence Reference, while a Conduct Report points at the Quest record — the
Assignment, the Proof Submission, and their times. The clearest case is
"unreachable": the complaint is that no Message exists, so there is nothing for
an Evidence Reference to name.

### Reasons

The reason list is fixed, not freeform, and the options depend on the filer's
role and the reported Member's role on that Quest.

| Filer → Reported | Reason | When it may be filed |
| --- | --- | --- |
| Hirer → Worker | `CONDUCT_ABANDONED` (abandoned the work, or unreachable) | In `SINGLE` and `GROUP + FIRST_COME_FIRST_SERVED`, against a Worker who sent no Proof Submission and made no proof-free confirmation. In `GROUP + CANDIDATE`, against the **Team Leader only**, and only when no Team Proof Submission or Team confirmation was sent |
| Worker → Hirer | `CONDUCT_OUT_OF_SCOPE` (demanded work beyond the Quest Condition, or commissioned dishonest or unlawful work) | Any Quest State from `QUEST_ASSIGNED` onward, `QUEST_COMPLETED` included — a Worker may finish the work under protest and report afterwards |
| Worker → Worker on the same Quest | `CONDUCT_NO_SHOW` (did not turn up for the agreed work) | `GROUP + FIRST_COME_FIRST_SERVED` only, against a Worker who sent no Proof Submission and made no proof-free confirmation |

The third column keeps a report from contradicting the Quest record it rests
on, and keeps it aimed at one Member rather than a whole Team:

- `ASSIGNMENT_INCOMPLETE` on its own is not enough. A Worker who submitted work
  the Hirer then decided `PROOF_NOT_APPROVED` also ends
  `ASSIGNMENT_INCOMPLETE`, and that Worker abandoned nothing. The gate is the
  missing action, not the failed Assignment.
- A `GROUP + CANDIDATE` Team shares one Assignment outcome, so the Quest record
  cannot say which member worked. Only the Team Leader carries a duty there:
  `work-chat-system-target.md` §Start Work makes the Team Leader the required
  starter and the required submitter. A Conduct Report in that mode therefore
  names the Team Leader and nobody else, which keeps one Team Leader's missing
  submission from putting a strike on every teammate. `CONDUCT_ABANDONED` is
  the only Conduct Report reason that reaches a Worker on a
  `GROUP + CANDIDATE` Quest; `CONDUCT_NO_SHOW` does not exist there.

The product's own report list also carries "delivered the work late" for a
Hirer reporting a Worker. It is **dropped**, for the same reason `PC-10` was:
it has no trigger. `work-chat-system-target.md` §Due time and §Proof
Submission protocol both state that the Server does not accept a required
action or a Proof Submission after `dueAt`, so a Worker either delivers on
time or does not deliver at all. The second case is `CONDUCT_ABANDONED`.

Abusive language and harassment appear in all three relationships in the
product's own report list, but they are **not** Conduct Report reasons. They
are Message content, so they open a Report Case under §5. One report list in
the UI therefore routes to two records; the reason the Member picks decides
which one.

### Filing

- Only a Member who held the stated role on that Quest may file: the Hirer, or
  a Worker who held an Assignment on it.
- `CONDUCT_NO_SHOW` needs both Members to have held an Assignment on the same
  Quest **and** to have owed their own work, so it exists only on a
  `GROUP + FIRST_COME_FIRST_SERVED` Quest. `GROUP + CANDIDATE` gives a
  teammate no duty of their own to fall short of, and a Hirer's
  `CONDUCT_ABANDONED` against the Team Leader already covers a Team that
  delivered nothing.
- A filer may file at most one Conduct Report per reported Member per Quest.
- The filing window opens when the Quest reaches `QUEST_ASSIGNED` and closes
  **1 day** after the Quest becomes Terminal. Filing during the Quest is
  allowed on purpose: `CONDUCT_OUT_OF_SCOPE` covers unlawful or dishonest
  work, which a Worker must be able to report the moment they meet it rather
  than after finishing the Quest. The 1-day tail matches the Dispute Case
  self-file window in §2, so a Member with both complaints files them in one
  sitting.
- Each reason narrows that window further through the third column of the
  table above. In practice only `CONDUCT_OUT_OF_SCOPE` can be filed while the
  Quest is still running; the other two need an Assignment that has already
  ended incomplete.
- Unlike a Dispute Case, a Conduct Report moves no money, so the 7-day money
  hold does not bound it, and it is not limited to a `QUEST_FAILED` Quest.

### Admin access

- Admin reads the Quest record the report names: the Assignment, the Proof
  Submission and its times, and the Quest's own State history. This needs no
  Evidence Reference and grants no Work Chat access. §5's rule stands
  unchanged: Message content stays reachable only through a Report Case.

### Decision

- Admin resolves a `CONDUCT_REPORT_PENDING` report as
  `CONDUCT_REPORT_UPHELD` or `CONDUCT_REPORT_DISMISSED`. There is no third
  outcome and no warning tier; §6's `PC-12` exemption already absorbs a
  Member's early violations.
- A decision requires a reason and a non-blank `Idempotency-Key`.
- The first confirmed decision is final, and every decision creates an Audit
  Record.
- `CONDUCT_REPORT_UPHELD` is a confirmed violation on the
  Misconduct ladder in §6, counted in the same sequence as a
  `REPORT_CASE_HIDDEN` decision on the Misconduct ladder in §6, and subject to
  the same `PC-12` and `PC-13` exemptions. A Conduct Report has no restore path, so a strike it creates
  carries no reversal.

### Notification

- `CONDUCT_REPORT_UPHELD` sends a Push Notification to the reported Member
  naming the reason and the result. Filing sends nothing, and
  `CONDUCT_REPORT_DISMISSED` sends nothing.
- No notification names the filer, and a filer is never shown to the reported
  Member. Telling a Member at filing time would identify the filer while the
  Quest may still be running, and invite retaliation.
- This is the same shape as §5, where only `REPORT_CASE_HIDDEN` reaches the
  offending Member.

### Retention

A Conduct Report is retained for **one year after its Quest becomes
Terminal**, the rule `work-chat-system-target.md` §Audit and retention already
sets for Quest Audit Records. ADR 0015's formula does not apply: that formula
is keyed to a Message and to an Evidence Reference holding it, and a Conduct
Report has neither. A strike that a `CONDUCT_REPORT_UPHELD` decision wrote into
`memberPenaltyRecord` outlives this retention, because §6 derives ladder
position and exemption counters from the whole life of an account.

## Known gaps

Not designed in this pass — flagged rather than silently assumed:

- **Admin managing other Admin accounts** (enabling/disabling). `authAdmin.disabledAt`
  exists and is checked by `enabledAdminGuard`, but no route sets it for one
  Admin acting on another. Explicitly out of scope for this document.
- **Schema-only columns with no defined behavior**: `questEditHistory.editedByAdminId`,
  `paymentPayoutCancellationAttempts.adminId`,
  `paymentMoneyPolicyRevision.authoredByAdminId`. Not addressed here.
- **A teammate who ghosts a `GROUP + CANDIDATE` Team cannot be reported.**
  That mode gives every member one shared Assignment outcome and puts the Start
  Work and submission duties on the Team Leader alone, so the Quest record
  holds no evidence about any other member. §7 therefore drops
  `CONDUCT_NO_SHOW` from that mode entirely and aims `CONDUCT_ABANDONED` at the
  Team Leader alone. Reaching the individual would need per-member Start Work
  in `work-chat-system-target.md` §Start Work, which is a Quest-rule change and
  was deliberately not taken.
- **A Conduct Report cannot be appealed.** §7 gives it two outcomes and no
  restore path, so a `CONDUCT_REPORT_UPHELD` strike is permanent, while a
  `REPORT_CASE_HIDDEN` strike can be reversed by a later
  `REPORT_CASE_RESTORED` (§6 **Reversal**). The asymmetry is accepted for now;
  an appeal route was not designed in this pass.
- **Insufficient-Hirer-balance handling** when a Dispute Case resolves after
  its Quest's 7-day money hold has already released the funds — accepted as
  a risk per the money-hold design above, not designed around further.
- **A `REPORT_CASE_HIDDEN` case never closes.** ADR 0015 sets `caseClosedAt`
  only at `REPORT_CASE_DISMISSED` or `REPORT_CASE_RESTORED`, so a hidden
  Message keeps its retention hold with no expiry, and nothing schedules a
  re-review. Accepted as designed here; changing it needs ADR 0015 revised.
- **A `QUEST_CANCELLED` Quest has no Dispute Case path**, including the
  `QUEST_ASSIGNED` cancellation that pays an Active Worker only 20%.
  Deliberate: `CONTEXT.md` scopes a Dispute Case to a Failed Quest.
- **A Hirer-filed Dispute Case can only move money away from the filer**,
  because money flows Hirer to Worker only. It is kept as a route for a Hirer
  who accepts that the failure was their own fault.

## Known conflicts

Current code that does not yet match this document:

- `POST /api/v1/admin/quests/:questId/dispute/resolve`
  (`quest-settlement.route.ts`) operates on the legacy `QUEST_DISPUTED`
  Quest state and predates this document's Dispute Case design. It must
  migrate to operate against `QUEST_FAILED` and the Dispute Case model in
  §2 before implementation aligns with this target.
- `quest.schema.ts` ties `hiddenAt` to a Quest State. Its CHECK
  `(hidden_at IS NULL) = (quest_status <> 'QUEST_HIDDEN')` makes it impossible
  to set `hiddenAt` without also overwriting the Quest's real State with
  `QUEST_HIDDEN`. §3 requires the opposite. Implementation must drop that
  CHECK and remove `QUEST_HIDDEN` from the `quest_status` enum, so `hiddenAt`
  becomes an independent flag and the seven Quest States in
  `work-chat-system-target.md` stay complete.
- `quest.schema.ts`'s `hiddenByAdminId`/`editedByAdminId` exist with no
  route. This document's §3 is the first specified use of
  `hiddenByAdminId`; `editedByAdminId` remains unaddressed (see
  [Known gaps](#known-gaps)).
- `wallet.schema.ts`'s `walletStatuses` (`ACTIVE`/`FROZEN`/`SUSPENDED`/`CLOSED`)
  are not entity-prefixed, unlike Quest/Assignment/Conversation/etc. in
  `work-chat-system-target.md`. This document cites the existing values
  as-is rather than renaming a live, migrated enum.
- `auth_user` has no `disabledAt`, `bannedUntil`, or `redFlagExpiresAt`
  column. Only `auth_admin` carries `disabled_at` (`auth.schema.ts`,
  `drizzle/0002_groovy_vertigo.sql`), and `auth.openapi.ts` exposes it on
  `AdminAuthUser`, not on `AuthUser`. §6 needs the two new Member columns
  created, plus a Member auth guard that rejects a session while a ban is
  active — the Member-side equivalent of `enabledAdminGuard`.
- `CONTEXT.md`'s Report Case entry previously listed bare, unprefixed status
  values; it is updated alongside this document to the prefixed values in
  [State and status naming](#state-and-status-naming).
- Every document that carried text this one supersedes has been corrected:
  `work-chat-system-target.md` §Dispute Case and §Reward and money contract,
  the two `quest-lifecycle.md` tables, ADR 0015's Report Case values, and
  ADR 0021's mechanism. Only code conflicts remain in this list.

---

## Follow-up work

> **Delete this section when every box is ticked.** It exists because the
> grilling session on 2026-08-30 was allowed to change only this file and
> `docs/adr/0024-hold-quest-failure-settlement-for-dispute-window.md`. Every
> item below is a change this document makes necessary somewhere else. The
> reasons are in [Known gaps](#known-gaps) and
> [Known conflicts](#known-conflicts); this is the task list only.

**Order.** Three schema items block most of the rest, so land them first:
`QUEST_FAILED` in the `quest_status` enum, the `hiddenAt` CHECK drop, and the
Member ban columns with `memberPenaltyRecord`. Each blocking item carries a
**Blocks §N** marker below. Everything under
[Documents to correct](#documents-to-correct) and
[Terms to add to `CONTEXT.md`](#terms-to-add-to-contextmd) is independent of
the schema and may be done at any time.

**A human answers [Facts to confirm](#facts-to-confirm).** Both items need a
source outside this repository, so an Agent cannot close them by reading code.
Ask instead of guessing.

**Each box is one commit.** Tick the box in the same commit that makes the
change, so this list stays true. The work is complete when every box is ticked
and this section is deleted.

### Documents to correct

- [x] `docs/quest/work-chat-system-target.md` §Deferred Dispute Case — it
      still says a Dispute Case's actors, deadline, decision rules, Group
      behavior, and payment integration are outside its target. Replace the
      section with a pointer to §2 of this document.
- [x] `docs/quest/quest-lifecycle.md` — the three stale rows in
      §Remaining non-lifecycle policies, plus §Alternative flows ("deferred
      abstraction"), §Docs versus code gaps ("Conflict / Unclear"), §Authority,
      and §Canonical and accepted sources, which named no Admin rulebook.
- [x] `docs/quest/quest-lifecycle.md` §Accepted target rules not yet
      implemented — the Dispute Case row still reads "Excluded from target
      scope".
- [x] `docs/adr/0015-work-chat-retention-and-account-deletion.md` — replace
      the bare `PENDING`/`DISMISSED`/`HIDDEN`/`RESTORED` Report Case values
      with the prefixed values in
      [State and status naming](#state-and-status-naming). The retention
      formula itself does not change.
- [x] `docs/adr/0021-keep-escrow-during-moderation-hide.md` — its "Outside
      the accepted Quest lifecycle" banner is now wrong. §3 decides the same
      subject and reaches the same result: hiding never moves Quest Escrow.
      Either re-accept the ADR against §3 or supersede it explicitly.

### Terms to add to `CONTEXT.md`

- [ ] **Quest Hide** — §3 defines the behavior, but no glossary entry names
      the concept.
- [ ] A name for the 7-day money hold in §2 and ADR 0024. It is a distinct
      money state and today it has no term.

### Schema and migration

- [ ] Drop the `quest.schema.ts` CHECK
      `(hidden_at IS NULL) = (quest_status <> 'QUEST_HIDDEN')` and remove
      `QUEST_HIDDEN` from the `quest_status` enum, so `hiddenAt` becomes an
      independent flag. **Blocks §3.**
- [ ] Add `QUEST_FAILED` to the `quest_status` enum. It is the state every
      Dispute Case in §2 starts from, and the enum does not contain it.
      **Blocks §2.**
- [ ] Add `auth_user.banned_until` and `auth_user.red_flag_expires_at`.
      Neither column exists. **Blocks §6.**
- [ ] Create the `memberPenaltyRecord` table described in
      [Data shape](#data-shape-not-yet-in-schema). **Blocks §6.**
- [ ] Create the Report Case, Reporter Entry, Evidence Reference, Moderation
      Decision, and Admin Action tables. None of them exist. **Blocks §5.**
- [ ] Create the Conduct Report table, keyed to a Quest and a reported Member
      rather than a Message, carrying the fixed reason, optional detail, the
      three statuses, and the Admin decision. **Blocks §7.**
- [ ] Create the Dispute Case table. **Blocks §2.**

### Code to change

- [ ] `POST /api/v1/admin/quests/:questId/dispute/resolve`
      (`quest-settlement.route.ts`) operates on the legacy `QUEST_DISPUTED`
      Quest state. Migrate it to `QUEST_FAILED` and the §2 Dispute Case
      model.
- [ ] Extend the Member auth guard to reject a session while a ban is
      active — the Member-side equivalent of `enabledAdminGuard`. It must
      read both `auth_user.banned_until` and the permanent tier in
      `memberPenaltyRecord`, and recompute that column whenever a strike is
      written or reversed, since it projects the later of the two ladders
      (§6).
- [ ] Keep the Quest's Funding Reservation `ACTIVE` for 7 days after
      `QUEST_FAILED`, and add the scheduled `FUNDING_RELEASE` at day 7
      (§2 Money hold, ADR 0024).
- [ ] Settle a post-failure Proof approval from that same reservation rather
      than from the Hirer's Spending Balance (§2 Money hold).
- [ ] Add the Quest Hide and restore Admin routes. `hiddenAt` and
      `hiddenByAdminId` exist with no route (§3).
- [ ] Add the Wallet Freeze/Suspend Admin route. `changeWalletStatus`
      (`wallet.status.service.ts`) exists, but no Admin route calls it (§4).
- [ ] Auto-freeze a Wallet when a ban starts, and return it to `ACTIVE` when
      a temporary ban expires (§4, §6).
- [ ] Add the Trust & Safety Admin routes: report a Message, read evidence
      through an Evidence Reference, and dismiss/hide/restore a Report Case
      (§5).
- [ ] Add the Conduct Report routes, and route the one product report list to
      a Report Case or a Conduct Report by the reason the Member picks
      (§7 §Reasons).
- [ ] Make `REPORT_CASE_RESTORED` reverse the strike its earlier
      `REPORT_CASE_HIDDEN` created: write the linked reversing row, clear any
      Red Flag or ban that strike produced, and count the ladder over
      non-reversed rows only (§6 **Reversal**).

### Facts to confirm

- [x] Confirm `PC-09` to `PC-13` against the penalty-constants table held
      outside this repository. Confirmed 2026-08-30: the values in §6 stand,
      including the 10-violation exemption, so a Member's first result arrives
      at confirmed violation 11.
- [x] Decide `PC-10` against the rule that an Active Worker cannot voluntarily
      leave a Quest. Decided 2026-08-30: `PC-10` is dropped.
- [x] Finish the §7 Conduct Report design. Decided 2026-08-30: three statuses,
      two Admin outcomes, a window from `QUEST_ASSIGNED` to 1 day after
      Terminal, `CONDUCT_REPORT_UPHELD` counting on the §6 Misconduct ladder, Push
      to the reported Member on `CONDUCT_REPORT_UPHELD` only, and one-year
      retention after the Quest becomes Terminal.
