# Include Platform Fee in Quest Funding Total

The v2 Quest contract treats the per-Worker-slot `Quest Funding Total` as the Hirer's inclusive commitment, supplied as `questFundingTotal` in Baht. It is split into the net `Quest Reward` paid to the Worker and the `Platform Fee` calculated from that Reward by the active `Money Policy`, with any rounding remainder kept in the fee. `Quest Escrow` reserves this total for each published headcount slot, and a successful publish returns the canonical open Quest with its finance snapshot. Hirer-owned reads may show the finance snapshot, while Public and Worker reads show only the applicable Quest Reward. This keeps the Hirer-facing budget fixed while preserving the domain meaning of `Quest Reward` and `Platform Fee`.

## Worker price visibility amendment — 2026-10-02

The requested Worker price display supersedes the funding-total exclusion above.
Board, Public Detail, and Participation Detail now expose the Hirer's inclusive
Quest Funding Total per published Worker slot. Net Quest Reward remains separate
for acceptance and underfilled consent. Platform Fee, Money Policy, Wallet, and
Funding Reservation internals remain private. Participation Detail exposes only
the authenticated Worker's own settlement: credited integer satang and time, or
pending/no-payment status. A completed Assignment alone does not prove payment.
For GROUP + CANDIDATE, the selected Team Leader receives the reward pool; other
Team Members do not show a pending transfer merely because their work completed.
