# ADR 0036: Split a Team Dispute Case Payout Through the Team Leader

## Status

Accepted

## Context

A `GROUP + CANDIDATE` Quest can become `QUEST_FAILED`. The whole Candidate Team
worked on it, but a Dispute Case named one Worker and one amount. Each team
member had to file alone, and the Admin had to pick who gets the money. ADR 0034
already lets the Team Leader split a Reward after success. A failed Quest needs
the same idea, with one extra risk: the 7-day money hold (ADR 0024) can end
before the Team Leader splits the money.

## Decision

1. **One filer.** Only the Team Leader of the selected Candidate Team files the
   Dispute Case. The case stores `teamId` and covers every team member. A team
   member who is not the Team Leader cannot file (`DISPUTE_CASE_TEAM_LEADER_ONLY`).
   The Hirer can still file the Hirer's own case. The filing windows (1 day for a
   Member, 5 days for an Admin) do not change.
   _Reason:_ one case gives the Admin one decision and prevents two cases from
   claiming the same held money.
2. **Admin approves the case, not a person or an amount.** For a team case the
   Admin decision `DISPUTE_CASE_RESOLVED` approves all that the hold can still
   pay, after other unpaid team approvals of the same Quest
   (`DISPUTE_CASE_AMOUNT_EXCEEDS_HOLD` if nothing is left). No money moves at
   this step. The case records the Team Leader as `resolvedWorkerId`.
   _Reason:_ the Admin does not know how the team shared the work, and the Admin
   web has no control for a partial amount.
3. **Leader split window: 24 hours** from the Admin decision, the same as ADR 0034.
   _Reason:_ one rule for the team and for the app. The window is short, so the
   hold stays bounded (see decision 7).
4. **Split input.** The Team Leader sends the share of every team member, the
   Team Leader included, in integer basis points (one basis point is 0.01%). The
   shares must total exactly 10000. A member can have 0. The command is
   idempotent (`Idempotency-Key`), and a confirmed split cannot change.
   _Reason:_ ADR 0034 uses basis points. Here the Team Leader does not receive an
   implicit remainder, because the Team Leader is one of the paid members.
5. **Rounding.** The Server rounds each amount down. The Satang that remain go
   one by one to the largest fractional remainders, and a tie goes to the member
   who joined the team first. The amounts always add up to the approved amount.
   _Reason:_ money stays in integer Satang with no lost or created Satang
   (same method as ADR 0034).
6. **Leader does not split.** After the deadline the lifecycle worker splits
   equally (ADR 0034 rule, remainder in roster order) and pays.
   _Reason:_ the team must not lose approved money because of one idle member.
7. **Hold and balance.** While a team approval is not paid, the day-7 hold release
   skips that Quest. The pause ends at most about 24 hours after the Admin decision
   plus payment retries. If the hold already ended before the decision, payment
   uses the Hirer's Spending Balance, as ADR 0024 allows. Before the first
   payment, the Server checks that the hold (or, after release, the remaining cap
   and the Hirer's Spending Balance) can pay the whole split. If it cannot, nobody
   is paid. The split stays `SPLIT_CONFIRMED` with a `paymentFailureCode`, and the
   worker retries until it pays.
   _Reason:_ a partial payment would pay some members and not others. ADR 0024
   called an unbounded pause a bad trade-off; this pause is bounded by decision 3.
8. **Payment and evidence.** One `settleDisputeCase` call per member, with the
   settlement reference `dispute-team-split:{allocationId}:{memberId}`. Each paid
   member row stores the `ledgerTransactionId` and `paidAt`
   (`admin_dispute_team_allocation_members`). A retry cannot pay a member twice.
   _Reason:_ the existing Wallet verb is ledger-backed and idempotent, and one
   Ledger Transaction per member gives each person their own payment evidence.
9. **App contract.** The Quest `dispute` object adds `viewerRole`
   (`HIRER`, `TEAM_LEADER`, `TEAM_MEMBER`, `WORKER`), `teamCase`, and `teamSplit`.
   `canFile` is false for a `TEAM_MEMBER`. `teamSplit.canSubmitSplit` is true only
   for the Team Leader before the deadline. `GET` and `POST`
   `/api/v1/quests/:questId/disputes/team-split` read and confirm the split.

## Consequences

- A team Dispute Case adds two tables and `admin_dispute_cases.team_id`.
- The Wallet gets one read verb, `readDisputeFundsAvailable`.
- The day-7 hold can last longer than 7 days for a Quest with an unpaid team
  split. This amends the word "unconditionally" in ADR 0024.
- If the hold ended and the Hirer spent the money, the split stays unpaid until
  the Hirer's Spending Balance can cover it. This is the existing accepted
  operational risk of a late Dispute Case, now visible as `paymentPending`.
