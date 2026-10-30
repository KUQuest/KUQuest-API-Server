# Separate the Quest Board Card from Public Quest Detail

Quest v2 uses a compact `Quest Board Card` for Board discovery and a separate
`Public Quest Detail` projection at `/api/v2/quests/:questId/public`. This keeps
mobile Board payloads small, lets Members request the full Quest Condition and
Quest Images on demand, and makes the Public projection's Finance exclusions
explicit instead of making one path return role-dependent schemas.

Status: accepted.

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
