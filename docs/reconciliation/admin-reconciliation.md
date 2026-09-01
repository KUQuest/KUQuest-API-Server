# Admin Operations: Current Implementation and Accepted Target

## Purpose

This reconciliation guide maps Legacy Implementation to accepted Rulebooks. It
does not define Admin policy.

The Admin Rulebook (`docs/rulebook/admin/admin-rulebook.md`) defines the
accepted target behavior for all Admin operations: Payout Approval, Dispute
Case, Quest Hide, Wallet Freeze/Suspend, Trust & Safety moderation, Conduct
Report review, and Member Ban penalty ladders.

Legacy Implementation contains partial implementations (such as Payout
Approval and Wallet Status service methods), legacy routes operating on
deprecated states (such as `QUEST_DISPUTED`), schema-only columns with no
active routes, and unbuilt moderation and penalty models.

## Source status

| Status | Meaning |
| --- | --- |
| **Confirmed** | The Rulebook and Legacy Implementation agree. |
| **Docs Only** | Rulebook behavior has no verified implementation. |
| **Partial** | Some target behavior has verified implementation, but the full area is incomplete. |
| **Code Only** | Legacy Implementation behavior has no Rulebook policy. |
| **Conflict** | The Rulebook and Legacy Implementation define different behavior. |
| **Unclear** | Evidence does not define one behavior. |
| **Not Specified** | The Rulebook does not define the rule. |

### Authority

1. `CONTEXT.md` defines canonical domain language.
2. `docs/rulebook/admin/admin-rulebook.md` defines accepted Admin policy;
   `docs/rulebook/quest/quest-work-chat-rulebook.md` defines accepted Quest and
   Work Chat policy.
3. ADRs record architectural decisions.
4. `src/modules/*` and `src/database/schema/*` show Legacy Implementation.
5. `docs/deprecated/` is historical evidence, not policy.

## Admin operational areas

| Area | Rulebook requirement | Current implementation evidence | Status |
| --- | --- | --- | --- |
| **Payout Approval** | Manual Admin approval queue (`PENDING_ADMIN_APPROVAL`), approve/reject actions with `Idempotency-Key`, masked destination display, Payout worker hand-off. | `payout.admin.route.ts`, `payout.admin.controller.ts`, `payout.admin.service.ts`; ADR `0022-manual-admin-approval-for-payouts.md` | **Confirmed**. |
| **Dispute Case** | Admin resolves Dispute Case on `QUEST_FAILED` Quests within 5-day window. Resolves to `DISPUTE_CASE_DISMISSED` or `DISPUTE_CASE_RESOLVED` with positive satang redirection. 7-day money hold delays funding release. | `POST /api/v1/admin/quests/:questId/dispute/resolve` (`quest-settlement.route.ts`) operates on legacy `QUEST_DISPUTED` state. No Dispute Case table exists. | **Conflict / Docs Only**. |
| **Quest Hide** | Admin hides/restores non-terminal Quests via independent `hiddenAt`/`hiddenByAdminId` flags without mutating Quest State. Requires reason and `Idempotency-Key`. Sends Push Notification to Hirer. | `quest.schema.ts` has `hiddenAt`/`hiddenByAdminId` columns but ties `hiddenAt` to `QUEST_HIDDEN` state via CHECK constraint. No Admin hide/restore routes exist. | **Conflict / Docs Only**. |
| **Wallet Freeze/Suspend** | Admin sets Student Wallet to `FROZEN` or `SUSPENDED` with reason and `Idempotency-Key`. Blocks new financial and Quest commitments while honoring existing obligations. Auto-freeze on ban. | `changeWalletStatus` exists in `wallet.status.service.ts`, but no Admin route calls it. No auto-freeze on ban hook exists. | **Docs Only**. |
| **Trust & Safety (Messages)** | Moderation of reported Work Chat and Candidate Inquiry Messages. Decisions: `REPORT_CASE_DISMISSED`, `REPORT_CASE_HIDDEN` (creates Misconduct strike), `REPORT_CASE_RESTORED` (reverses strike). Evidence access via Evidence Reference. | Shared Admin Action infrastructure now exists in `admin.schema.ts` and `admin-action.service.ts`; Report Case, Reporter Entry, Evidence Reference, and Moderation Decision tables and routes remain absent. | **Docs Only / Partial**. |
| **Conduct Report (Quests)** | Review of Member behavior on Quests (reasons: `CONDUCT_NO_SHOW`, `CONDUCT_ABANDONED`, `CONDUCT_POOR_QUALITY`, `CONDUCT_INAPPROPRIATE_BEHAVIOR`). Decisions: `CONDUCT_REPORT_PENDING`, `CONDUCT_REPORT_UPHELD` (creates Misconduct strike), `CONDUCT_REPORT_DISMISSED`. | No Conduct Report table or routes exist. | **Docs Only**. |
| **Member Ban & Penalty Ladders** | Two penalty ladders (Misconduct ladder and Low Average Review ladder). Results: Red Flag (7 days), Temporary Ban (7 days), Permanent Ban. Backed by immutable `memberPenaltyRecord` audit table. Auth guard checks active ban. | `auth_user` lacks `bannedUntil` and `redFlagExpiresAt` columns. Only `auth_admin` carries `disabled_at`. No `memberPenaltyRecord` table or Member ban auth guard exists. | **Docs Only**. |

## Docs versus code gaps

| Area | Documentation | Code | Classification |
| --- | --- | --- | --- |
| Dispute Case route and target state | Target operates against `QUEST_FAILED` and resolves via `DISPUTE_CASE_RESOLVED` / `DISPUTE_CASE_DISMISSED` with satang redirection from 7-day held Funding Reservation. | `POST /api/v1/admin/quests/:questId/dispute/resolve` (`quest-settlement.route.ts`) operates on legacy `QUEST_DISPUTED` state with `REFUND_HIRER` or `RELEASE_TO_WORKER`. | **Conflict** — `admin-rulebook.md` §2; `quest-settlement.route.ts`. |
| Quest Hide schema constraint | `hiddenAt` is an independent timestamp flag that operates across any non-terminal Quest State (`QUEST_OPEN`, `QUEST_ASSIGNED`, `QUEST_IN_PROGRESS`) without changing Quest State. | `quest.schema.ts` contains CHECK `(hidden_at IS NULL) = (quest_status <> 'QUEST_HIDDEN')` and includes `QUEST_HIDDEN` in the `quest_status` enum. | **Conflict** — `admin-rulebook.md` §3; `quest.schema.ts`. |
| Quest Hide Admin routes | Target specifies Admin routes to hide (with reason) and restore Quests, sending Push Notifications to the Hirer. | `hiddenAt` and `hiddenByAdminId` columns exist in `quest.schema.ts`, but no Admin routes exist to invoke them. | **Docs Only / Gap** — `admin-rulebook.md` §3. |
| Member Ban columns and guard | Target requires `auth_user.banned_until` and `auth_user.red_flag_expires_at` for O(1) guard checks, backed by `memberPenaltyRecord`. Auth guard rejects active bans. | `auth_user` has neither column. Only `auth_admin` carries `disabled_at` (`auth.schema.ts`, `drizzle/0002_groovy_vertigo.sql`). No Member ban guard exists. | **Docs Only / Gap** — `admin-rulebook.md` §6. |
| Member Penalty Record table | Target requires immutable `memberPenaltyRecord` table storing strikes, sequence numbers, results, and linked reversing rows. | Table does not exist in schema. | **Docs Only / Gap** — `admin-rulebook.md` §6. |
| Moderation tables | Target requires Report Case, Reporter Entry, Evidence Reference, and Moderation Decision tables. The shared Admin Action table is tracked separately below. | Those four tables do not exist in schema. | **Docs Only / Gap** — `admin-rulebook.md` §5. |
| Conduct Report table | Target requires Conduct Report table keyed to Quest and reported Member with fixed reason enums and Admin decisions. | Table does not exist in schema. | **Docs Only / Gap** — `admin-rulebook.md` §7. |
| Dispute Case table | Target requires Dispute Case table keyed to `QUEST_FAILED` Quest and Member with filing window tracking. | Table does not exist in schema. | **Docs Only / Gap** — `admin-rulebook.md` §2. |
| Wallet Freeze Admin route | Target specifies Admin route to freeze or suspend a Student Wallet with reason and `Idempotency-Key`. | `changeWalletStatus` exists in `wallet.status.service.ts`, but no Admin HTTP route is wired to invoke it. | **Docs Only / Gap** — `admin-rulebook.md` §4. |
| Wallet Auto-freeze on ban | Target requires auto-freezing a Student Wallet when a ban starts and restoring to `ACTIVE` when a temporary ban expires. | No wallet status hook or worker listens to Member ban lifecycle. | **Docs Only / Gap** — `admin-rulebook.md` §§4, 6. |
| 7-day Money hold on failed Quest | Target holds Quest Funding Reservation `ACTIVE` for 7 days after `QUEST_FAILED`, releasing at day 7 if no dispute redirects it. | Reservation currently releases immediately upon terminal failure. | **Docs Only / Gap** — `admin-rulebook.md` §2; ADR `0024`. |
| Unaddressed schema-only columns | Schema contains columns with no defined runtime behavior: `questEditHistory.editedByAdminId`, `paymentPayoutCancellationAttempts.adminId`, `paymentMoneyPolicyRevision.authoredByAdminId`. | Columns exist in Drizzle schema definitions without corresponding business logic or routes. | **Code Only / Unaddressed**. |
| Wallet status naming convention | `walletStatus` enum uses unprefixed values (`ACTIVE`, `FROZEN`, `SUSPENDED`, `CLOSED`). | Live migrated database uses unprefixed values; Rulebook accepts them as-is. | **Confirmed as-is**. |

## Migration and implementation checklist

This checklist preserves the actionable engineering tasks required to align
the server implementation with the Admin Rulebook:

### Schema and migration

- [ ] Drop the `quest.schema.ts` CHECK `(hidden_at IS NULL) = (quest_status <> 'QUEST_HIDDEN')` and remove `QUEST_HIDDEN` from the `quest_status` enum, so `hiddenAt` becomes an independent flag.
- [ ] Add `QUEST_FAILED` to the `quest_status` enum.
- [ ] Add `auth_user.banned_until` and `auth_user.red_flag_expires_at` columns to `auth_user`.
- [ ] Create the `memberPenaltyRecord` table with strike sequence, penalty result, and linked reversing rows.
- [x] Create the shared immutable `adminAction` table and transaction-aware writer.
- [ ] Create the remaining Trust & Safety moderation tables: `reportCase`, `reporterEntry`, `evidenceReference`, and `moderationDecision`.
- [ ] Create the `conductReport` table keyed to Quest and reported Member.
- [ ] Create the `disputeCase` table keyed to `QUEST_FAILED` Quest and Member.

### Code and routes

- [ ] Migrate `POST /api/v1/admin/quests/:questId/dispute/resolve` (`quest-settlement.route.ts`) to operate on `QUEST_FAILED` and the Dispute Case model.
- [ ] Extend Member auth guard to reject sessions while a ban is active (evaluating `auth_user.banned_until` and permanent ban rows in `memberPenaltyRecord`).
- [ ] Implement 7-day money hold: keep Quest Funding Reservation `ACTIVE` for 7 days after `QUEST_FAILED`, with scheduled `FUNDING_RELEASE` at day 7.
- [ ] Settle post-failure Proof approval from the held reservation rather than Hirer Spending Balance during the 7-day window.
- [ ] Add Admin routes for Quest Hide (`POST /api/v1/admin/quests/:questId/hide`) and restore (`POST /api/v1/admin/quests/:questId/restore`).
- [ ] Add Admin route for Wallet Freeze/Suspend (`POST /api/v1/admin/wallets/:walletId/status`).
- [ ] Implement auto-freeze for Wallet on ban creation, and auto-unfreeze when temporary ban expires.
- [ ] Add Trust & Safety Admin routes: Message reporting, Evidence Reference retrieval, and case resolution (`REPORT_CASE_DISMISSED`, `REPORT_CASE_HIDDEN`, `REPORT_CASE_RESTORED`).
- [ ] Add Conduct Report routes and product report intake routing.
- [ ] Implement strike reversal logic for `REPORT_CASE_RESTORED` in `memberPenaltyRecord`.

## Sources

### Canonical and accepted sources

- `CONTEXT.md`
- `docs/rulebook/admin/admin-rulebook.md`
- `docs/rulebook/quest/quest-work-chat-rulebook.md`
- `docs/adr/0010-retain-and-correct-financial-records.md`
- `docs/adr/0014-work-chat-is-server-readable-for-moderation.md`
- `docs/adr/0015-work-chat-retention-and-account-deletion.md`
- `docs/adr/0021-keep-escrow-during-moderation-hide.md`
- `docs/adr/0022-manual-admin-approval-for-payouts.md`
- `docs/adr/0024-hold-quest-failure-settlement-for-dispute-window.md`

### Current, draft, comparison, and legacy sources

- `src/database/schema/quest.schema.ts`
- `src/database/schema/wallet.schema.ts`
- `src/database/schema/auth.schema.ts`
- `src/modules/quest/quest-settlement.route.ts`
- `src/modules/quest/quest-settlement.service.ts`
- `src/modules/payout/payout.admin.route.ts`
- `src/modules/payout/payout.admin.controller.ts`
- `src/modules/payout/payout.admin.service.ts`
- `src/modules/wallet/wallet.status.service.ts`
- `docs/db/edr/05-quest.sql`
- `docs/db/edr/02-wallet.sql`
