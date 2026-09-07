# Agent Routing Directory

Deterministic routing table for agents to navigate directly to authoritative domain policies, sub-contracts, architectural decisions, and reconciliation guides before planning or coding.

## 1. Quick Route by Task Branch

| Branch / Action | Authoritative Policy | Code-Level Gap & Checklist | Architecture Decision |
| --- | --- | --- | --- |
| **Domain Boundaries & Seams** | [domain-boundaries.md](../rulebook/domain-boundaries.md) | — | ADR 0005, ADR 0014, ADR 0021, ADR 0024 |
| **Selection & Roster** | [quest-lifecycle-contract.md](../rulebook/quest/quest-lifecycle-contract.md) | [quest-reconciliation.md](../reconciliation/quest-reconciliation.md) | ADR 0016 |
| **Mode x Shape (2x2 Matrix)** | [quest-mode-matrix-contract.md](../rulebook/quest/quest-mode-matrix-contract.md) | [quest-reconciliation.md](../reconciliation/quest-reconciliation.md) | ADR 0016 |
| **Candidate Team & Join Code** | [quest-lifecycle-contract.md](../rulebook/quest/quest-lifecycle-contract.md) | [quest-reconciliation.md](../reconciliation/quest-reconciliation.md) | — |
| **Start Work Protocol** | [quest-lifecycle-contract.md](../rulebook/quest/quest-lifecycle-contract.md) | [quest-reconciliation.md](../reconciliation/quest-reconciliation.md) | — |
| **Underfilled FCFS Consensus** | [quest-lifecycle-contract.md](../rulebook/quest/quest-lifecycle-contract.md) | [quest-reconciliation.md](../reconciliation/quest-reconciliation.md) | ADR 0016 |
| **Quest Cancellation** | [quest-lifecycle-contract.md](../rulebook/quest/quest-lifecycle-contract.md) | [quest-reconciliation.md](../reconciliation/quest-reconciliation.md) | — |
| **Quest Condition & Items** | [quest-condition-contract.md](../rulebook/quest/quest-condition-contract.md) | [quest-reconciliation.md](../reconciliation/quest-reconciliation.md) | — |
| **Quest Edit (10-Min Protocol)** | [quest-condition-contract.md](../rulebook/quest/quest-condition-contract.md) | [quest-reconciliation.md](../reconciliation/quest-reconciliation.md) | — |
| **Due Time & Reminders** | [quest-condition-contract.md](../rulebook/quest/quest-condition-contract.md) | [quest-reconciliation.md](../reconciliation/quest-reconciliation.md) | — |
| **Proof Submission & Drafts** | [proof-submission-contract.md](../rulebook/quest/proof-submission-contract.md) | [quest-reconciliation.md](../reconciliation/quest-reconciliation.md) | — |
| **Proof Review & 24h Auto-Approval** | [proof-submission-contract.md](../rulebook/quest/proof-submission-contract.md) | [quest-reconciliation.md](../reconciliation/quest-reconciliation.md) | ADR 0016, ADR 0020 |
| **Non-Approval & Admin Review Item** | [proof-submission-contract.md](../rulebook/quest/proof-submission-contract.md) | [quest-reconciliation.md](../reconciliation/quest-reconciliation.md) | ADR 0016 |
| **Candidate Inquiry (Pre-Assignment)** | [conversation-contract.md](../rulebook/quest/conversation-contract.md) | [quest-reconciliation.md](../reconciliation/quest-reconciliation.md) | ADR 0019 |
| **Work Chat & Membership** | [conversation-contract.md](../rulebook/quest/conversation-contract.md) | [quest-reconciliation.md](../reconciliation/quest-reconciliation.md) | ADR 0005, ADR 0014, ADR 0015 |
| **Chat Rate Limits & Attachments** | [conversation-contract.md](../rulebook/quest/conversation-contract.md) | [quest-reconciliation.md](../reconciliation/quest-reconciliation.md) | — |
| **Inclusive Funding & Satang Math** | [reward-money-contract.md](../rulebook/quest/reward-money-contract.md) | [quest-reconciliation.md](../reconciliation/quest-reconciliation.md) | ADR 0005, ADR 0006, ADR 0017 |
| **Quest Escrow Reservation** | [reward-money-contract.md](../rulebook/quest/reward-money-contract.md) | [quest-reconciliation.md](../reconciliation/quest-reconciliation.md) | ADR 0009, ADR 0017 |
| **Failure 7-Day Money Hold** | [reward-money-contract.md](../rulebook/quest/reward-money-contract.md), [admin-dispute-case-contract.md](../rulebook/admin/admin-dispute-case-contract.md) | [admin-reconciliation.md](../reconciliation/admin-reconciliation.md) | ADR 0024 |
| **Rating Review (Post-Terminal)** | [rating-review-contract.md](../rulebook/quest/rating-review-contract.md) | [quest-reconciliation.md](../reconciliation/quest-reconciliation.md) | — |
| **Quest Images (v2 Draft)** | [quest-image-contract.md](../rulebook/quest/quest-image-contract.md) | [quest-reconciliation.md](../reconciliation/quest-reconciliation.md) | — |
| **System Messages (KU Bot)** | [notification-audit-contract.md](../rulebook/quest/notification-audit-contract.md) | [quest-reconciliation.md](../reconciliation/quest-reconciliation.md) | — |
| **Android Push Notifications** | [notification-audit-contract.md](../rulebook/quest/notification-audit-contract.md) | [quest-reconciliation.md](../reconciliation/quest-reconciliation.md) | ADR 0017, ADR 0018 |
| **Audit Records & Retention** | [notification-audit-contract.md](../rulebook/quest/notification-audit-contract.md) | [quest-reconciliation.md](../reconciliation/quest-reconciliation.md) | ADR 0015 |
| **Admin Payout Approval** | [admin-payout-approval-contract.md](../rulebook/admin/admin-payout-approval-contract.md) | [admin-reconciliation.md](../reconciliation/admin-reconciliation.md) | ADR 0008, ADR 0022 |
| **Admin Dispute Case** | [admin-dispute-case-contract.md](../rulebook/admin/admin-dispute-case-contract.md) | [admin-reconciliation.md](../reconciliation/admin-reconciliation.md) | ADR 0024 |
| **Admin Quest Hide / Restore** | [admin-quest-hide-contract.md](../rulebook/admin/admin-quest-hide-contract.md) | [admin-reconciliation.md](../reconciliation/admin-reconciliation.md) | ADR 0021 |
| **Admin Wallet Freeze / Suspend** | [admin-wallet-freeze-contract.md](../rulebook/admin/admin-wallet-freeze-contract.md) | [admin-reconciliation.md](../reconciliation/admin-reconciliation.md) | — |
| **Admin Trust & Safety (Messages)** | [admin-trust-safety-contract.md](../rulebook/admin/admin-trust-safety-contract.md) | [admin-reconciliation.md](../reconciliation/admin-reconciliation.md) | ADR 0014, ADR 0015 |
| **Admin Penalty Ladders & Ban** | [admin-member-penalty-contract.md](../rulebook/admin/admin-member-penalty-contract.md) | [admin-reconciliation.md](../reconciliation/admin-reconciliation.md) | — |
| **Admin Conduct Reports** | [admin-conduct-report-contract.md](../rulebook/admin/admin-conduct-report-contract.md) | [admin-reconciliation.md](../reconciliation/admin-reconciliation.md) | — |
| **Wallet Compartments & Limits** | [wallet-compartment-contract.md](../rulebook/finance/wallet-compartment-contract.md) | — | ADR 0005 |
| **Double-Entry Ledger** | [double-entry-ledger-contract.md](../rulebook/finance/double-entry-ledger-contract.md) | — | ADR 0006, ADR 0010, ADR 0012 |
| **Funding Reservations & Escrow** | [funding-reservation-contract.md](../rulebook/finance/funding-reservation-contract.md) | — | ADR 0009, ADR 0017, ADR 0024 |
| **Top-up & Earnings Conversion** | [topup-and-conversion-contract.md](../rulebook/finance/topup-and-conversion-contract.md) | — | ADR 0005, ADR 0007 |
| **Payouts & Encrypted Destinations** | [payout-contract.md](../rulebook/finance/payout-contract.md) | — | ADR 0008, ADR 0022 |
| **Money Policy & Platform Fees** | [money-policy-contract.md](../rulebook/finance/money-policy-contract.md) | — | ADR 0005, ADR 0009 |

---

## 2. Route by Actor & Quest State

### Hirer
- `QUEST_DRAFT`: Upload/remove images ([quest-image-contract.md](../rulebook/quest/quest-image-contract.md)), fund and publish ([reward-money-contract.md](../rulebook/quest/reward-money-contract.md)).
- `QUEST_OPEN`: Answer Candidate Inquiries ([conversation-contract.md](../rulebook/quest/conversation-contract.md)), select Candidate / Candidate Team ([quest-lifecycle-contract.md](../rulebook/quest/quest-lifecycle-contract.md)), cancel Quest ([quest-lifecycle-contract.md](../rulebook/quest/quest-lifecycle-contract.md)).
- `QUEST_ASSIGNED`: Submit Quest Edit ([quest-condition-contract.md](../rulebook/quest/quest-condition-contract.md)), participate in Work Chat ([conversation-contract.md](../rulebook/quest/conversation-contract.md)).
- `QUEST_IN_PROGRESS`: Review submitted Proof ([proof-submission-contract.md](../rulebook/quest/proof-submission-contract.md)), Work Chat ([conversation-contract.md](../rulebook/quest/conversation-contract.md)).
- `QUEST_COMPLETED` / `QUEST_FAILED` / `QUEST_CANCELLED`: Submit Rating Review within 7 days ([rating-review-contract.md](../rulebook/quest/rating-review-contract.md)).

### Prospective Worker / Candidate
- `QUEST_OPEN`: Open 1-on-1 Candidate Inquiry ([conversation-contract.md](../rulebook/quest/conversation-contract.md)), join FCFS Quest or apply as Candidate / join Candidate Team with Join Code ([quest-lifecycle-contract.md](../rulebook/quest/quest-lifecycle-contract.md)).

### Worker
- `QUEST_ASSIGNED`: Start Work between `startTime` and `dueAt` ([quest-lifecycle-contract.md](../rulebook/quest/quest-lifecycle-contract.md)), respond to Quest Edit within 10 minutes ([quest-condition-contract.md](../rulebook/quest/quest-condition-contract.md)), Work Chat ([conversation-contract.md](../rulebook/quest/conversation-contract.md)).
- `QUEST_IN_PROGRESS`: Save draft and submit Proof (1–5 files) before `dueAt` ([proof-submission-contract.md](../rulebook/quest/proof-submission-contract.md)), Work Chat ([conversation-contract.md](../rulebook/quest/conversation-contract.md)).
- `QUEST_COMPLETED` / `QUEST_FAILED` / `QUEST_CANCELLED`: Submit Rating Review within 7 days ([rating-review-contract.md](../rulebook/quest/rating-review-contract.md)).

### Admin
- Payout Approval queue ([admin-payout-approval-contract.md](../rulebook/admin/admin-payout-approval-contract.md)).
- Dispute Case on `QUEST_FAILED` Quests within 5 days ([admin-dispute-case-contract.md](../rulebook/admin/admin-dispute-case-contract.md)).
- Quest Hide / Restore on active Quests ([admin-quest-hide-contract.md](../rulebook/admin/admin-quest-hide-contract.md)).
- Wallet Freeze / Suspend ([admin-wallet-freeze-contract.md](../rulebook/admin/admin-wallet-freeze-contract.md)).
- Message Moderation Report Cases ([admin-trust-safety-contract.md](../rulebook/admin/admin-trust-safety-contract.md)).
- Penalty Ladders, Red Flags, and Member Ban ([admin-member-penalty-contract.md](../rulebook/admin/admin-member-penalty-contract.md)).
- Conduct Reports review ([admin-conduct-report-contract.md](../rulebook/admin/admin-conduct-report-contract.md)).
---

## 3. Precedence Hierarchy

1. **`CONTEXT.md`**: Ubiquitous language definition. Always authoritative for domain terminology.
2. **Rulebooks & Sub-contracts** (`docs/rulebook/`): Authoritative for target business policy and state machine rules. Overrides Legacy Implementation.
3. **ADRs** (`docs/adr/`): Authoritative for technical and architectural decisions.
4. **Reconciliation Guides** (`docs/reconciliation/*-reconciliation.md`): Authoritative register of gaps between Legacy Code and Rulebooks, and task checklists for implementation.
5. **Deprecated docs** (`docs/deprecated/`): Historical context only. Never defines new behavior.
