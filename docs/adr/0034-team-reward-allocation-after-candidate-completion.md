# ADR 0034: Allocate Candidate Team Rewards After Successful Completion

## Status

Accepted

## Context

`GROUP + CANDIDATE` work completes as one Team outcome, but a single transfer to
the Team Leader leaves every teammate's share implicit. A percentage split must
preserve the published reward pool, prevent over-allocation, and pay each person
without turning an Escrow settlement into an unrelated Peer-to-Peer transfer.

## Decision

- Successful proof approval or proof-free confirmation completes all selected
  Assignments, then holds the Worker Reward and fee pools in Quest Escrow.
- The Team Leader has 24 hours to set each teammate's percentage in integer
  basis points (one basis point is 0.01%). Teammate percentages must total at
  most 100%; the Leader receives the remainder.
- On timeout, the Server assigns equal basis-point shares, distributing any
  remainder deterministically in selected roster order.
- The Server splits integer-satang Rewards and fees deterministically, then
  credits each member directly from Quest Escrow to Earnings in one transaction.
- The allocation command is idempotent. A submitted allocation is immutable.

## Consequences

The Quest can be `QUEST_COMPLETED` while settlement remains pending. Every team
member can read the roster, deadline, and final allocation; each participation
projection continues to expose only that member's own settlement amount.

## Amendment: cancellation

A `GROUP + CANDIDATE` cancellation from `QUEST_ASSIGNED` or `QUEST_IN_PROGRESS`
also opens this allocation for its Worker Reward pool, because a single transfer
to the Team Leader gave teammates no share. Quest Escrow keeps the pool and any
Hirer refund until the allocation settles, because a Funding Reservation can only
release its full remainder. The cancellation result reports the amounts that
settlement will move. A pending Team Completion Confirmation still pays no Reward
and refunds the Hirer at once.
