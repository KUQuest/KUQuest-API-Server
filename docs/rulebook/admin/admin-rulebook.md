# Admin Role and Operations Target Spec

Type: Rulebook
Status: accepted
Domain: Admin Operations
Authority: Defines accepted Admin policy and overrides Legacy Implementation in this domain. For shared flows, it owns Admin actions and timing; the Quest and Work Chat Rulebook owns Quest State and Assignment behavior.
Approved by: Domain Owner
Approved at: 2026-08-31

This document and its disclosed sub-contracts define the accepted target behavior for Admin operations: Payout Approvals, Dispute Cases, Quest Hiding, Wallet Freezing/Suspending, Trust & Safety message moderation, Member Penalty ladders, and Quest Conduct Reports.

## Read first

1. Read the root `CONTEXT.md` for the canonical vocabulary, then use this document and its sub-contracts for settled behavior.
2. Read `docs/adr/0022-manual-admin-approval-for-payouts.md`,
   `docs/adr/0010-retain-and-correct-financial-records.md`,
   `docs/adr/0014-work-chat-is-server-readable-for-moderation.md`,
   `docs/adr/0015-work-chat-retention-and-account-deletion.md`, and
   `docs/adr/0024-hold-quest-failure-settlement-for-dispute-window.md`.
3. Treat this document as the target contract for Admin behavior alongside `docs/rulebook/quest/quest-work-chat-rulebook.md` for Quest/Chat behavior. For shared flows:
   - This document owns Admin actions, moderation decisions, penalty enforcement, and the 7-day money hold on failed Quests.
   - The Quest Rulebook owns Quest State transitions, Assignment lifecycles, and chat permissions.

## Scope and permissions

Admin encompasses seven core areas of operational responsibility:

- **Payout Approval**: Approve or reject submitted Student Payouts.
- **Dispute Case**: Reverse part of a `QUEST_FAILED` settlement between Hirer and Worker.
- **Quest Hide**: Remove a Quest from public discovery without mutating its lifecycle or escrow.
- **Wallet Freeze/Suspend**: Restrict a Student's Wallet against starting new commitments.
- **Trust & Safety**: Moderate reported Work Chat and Candidate Inquiry Messages via Evidence References.
- **Member Ban & Penalties**: Enforce Misconduct and Low-Average-Review penalty ladders.
- **Conduct Report**: Review reports of Member misconduct on Quests based on Quest records.

**Permission tier**: Admin currently operates with a single undifferentiated permission tier. `authAdmin` has no role or permission column, only `disabledAt`. Every enabled Admin may perform all actions in this domain.

## State and status naming

Every persisted or API state/status value uses an entity prefix in the form `<ENTITY>_<VALUE>`.

| Object | Field | Allowed values |
| --- | --- | --- |
| Dispute Case | status | `DISPUTE_CASE_PENDING`, `DISPUTE_CASE_DISMISSED`, `DISPUTE_CASE_RESOLVED` |
| Report Case | status | `REPORT_CASE_PENDING`, `REPORT_CASE_DISMISSED`, `REPORT_CASE_HIDDEN`, `REPORT_CASE_RESTORED` |
| Conduct Report | status | `CONDUCT_REPORT_PENDING`, `CONDUCT_REPORT_UPHELD`, `CONDUCT_REPORT_DISMISSED` |
| Payout | status | `PENDING_ADMIN_APPROVAL` and provider processing statuses (ADR 0022) |
| Wallet | status | `ACTIVE`, `FROZEN`, `SUSPENDED`, `CLOSED` |

Member Ban state is read from the immutable `memberPenaltyRecord` audit table; `bannedUntil` and `redFlagExpiresAt` in `authUser` provide projected values for fast guard checks.

## Sub-contracts (Disclosed Reference)

Follow the context pointer for the Admin branch being planned or implemented:

| Branch / Responsibility | Topic and triggers | Sub-contract file |
| --- | --- | --- |
| **Payout Approval** | Manual approval queue under `/api/v1/admin/payouts`, masked destination accounts, idempotent approve/reject, provider worker hand-off. | [admin-payout-approval-contract.md](admin-payout-approval-contract.md) |
| **Dispute Cases** | Reversing `QUEST_FAILED` settlement, 1-day self-file window, 5-day Admin window, 7-day money hold in Funding Reservation, Satang redirection. | [admin-dispute-case-contract.md](admin-dispute-case-contract.md) |
| **Quest Hide & Restore** | Independent `hiddenAt`/`hiddenByAdminId` flags across non-terminal Quests, discovery removal only, Push notifications to Hirer, idempotency. | [admin-quest-hide-contract.md](admin-quest-hide-contract.md) |
| **Wallet Freeze & Suspend** | Setting `FROZEN`/`SUSPENDED` statuses, blocking new commitments while honoring active obligations, discretionary vs auto-ban freeze. | [admin-wallet-freeze-contract.md](admin-wallet-freeze-contract.md) |
| **Trust & Safety (Messages)** | Message moderation in Work Chat & Candidate Inquiries, Reporter Entries, Evidence References, hiding messages, strike creation, and retention. | [admin-trust-safety-contract.md](admin-trust-safety-contract.md) |
| **Member Penalty Ladders** | Misconduct ladder (Red Flag 7d, Temp ban 7d, Permanent ban), Review ladder (<3.0 average), `PC-12`/`PC-13` exemptions, strike reversals. | [admin-member-penalty-contract.md](admin-member-penalty-contract.md) |
| **Conduct Reports (Quests)** | Quest behavior reports (`CONDUCT_ABANDONED`, `CONDUCT_OUT_OF_SCOPE`, `CONDUCT_NO_SHOW`), filing windows, Quest record evidence, permanent strikes. | [admin-conduct-report-contract.md](admin-conduct-report-contract.md) |

## Scope boundaries & deferred capabilities

- **Admin managing other Admins**: Enabling or disabling other Admin accounts is out of scope.
- **Candidate Team member reporting**: A ghosting teammate on `GROUP + CANDIDATE` cannot be reported individually; only the Team Leader carries duties under `CONDUCT_ABANDONED`.
- **No Conduct Report appeal**: A `CONDUCT_REPORT_UPHELD` decision has no restore path and creates a permanent strike.
- **Insufficient Hirer balance risk**: When a Dispute Case resolves after the 7-day money hold has released funds, insufficient Hirer balance fails the transfer as an accepted operational risk.
- **Hidden Message retention hold**: A `REPORT_CASE_HIDDEN` case never auto-closes, retaining evidence indefinitely.
- **Failed Quest Dispute boundary**: Cancelled Quests have no Dispute Case path; Dispute Cases only redirect money from Hirer to Worker.
