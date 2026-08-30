# Domain Boundaries and Cross-Subsystem Contracts

Type: Rulebook Reference
Domain: Quest, Work Chat, Admin Operations, Finance
Authority: Defines accepted architectural boundaries, transaction ownership, and data access rules across subsystems. Overrides Legacy Implementation where boundaries overlap.

This document defines the strict seams, transaction boundaries, and access constraints between the Quest, Chat, and Admin domains.

---

## 1. Quest vs Chat Boundary

| Responsibility Area | Owning Subsystem | Contract Rule |
| --- | --- | --- |
| **Conversation Lifecycle & Membership** | **Quest Domain** | Quest owns all Conversation creation and Chat Membership transitions. Assignment creation and terminal transitions update Chat Membership in the same database transaction (ADR 0005) to guarantee atomicity. |
| **Messaging & Attachments** | **Chat Domain** | Chat owns message validation (&le;1,000 chars), attachment storage (images/PDF/video &le;10 MB, 15-minute temporary links), private Read Cursors, and rate limiting (30 msg / 10 att per min). |
| **Candidate Inquiry Disappearance** | **Quest & Chat** | Assignment creation or `QUEST_ASSIGNED` transition triggers a soft-close (`INQUIRY_CLOSED`). Chat APIs immediately exclude closed inquiries from Member views while preserving database records for audit and moderation. |
| **System Messages** | **Quest & Chat** | Quest events trigger immutable KU bot System Messages in Work Conversations only. Candidate Inquiry Conversations prohibit System Messages to prevent leaking quest state or candidate identities. |

---

## 2. Quest vs Admin Boundary

| Responsibility Area | Owning Subsystem | Contract Rule |
| --- | --- | --- |
| **Dispute Resolution** | **Admin Domain** | Admin resolves Dispute Cases on `QUEST_FAILED` Quests by executing a reversing Ledger Transaction from the 7-day held Funding Reservation (ADR 0024). Admin never reopens or alters the Quest State (`QUEST_FAILED` remains permanent). |
| **Quest Hiding** | **Admin Domain** | Hiding applies an independent `hiddenAt` timestamp flag that acts as a **Discovery Filter only** (ADR 0021). The Quest lifecycle, `dueAt` countdown, Start Work, Proof Submission, and Work Chat continue unaffected. |
| **Conduct Investigation** | **Admin Domain** | Admin investigates Quest conduct (`CONDUCT_ABANDONED`, `CONDUCT_OUT_OF_SCOPE`, `CONDUCT_NO_SHOW`) using Quest records and conversation history without mutating active Quest deadlines or assignments. |

---

## 3. Chat vs Admin Boundary

| Responsibility Area | Owning Subsystem | Contract Rule |
| --- | --- | --- |
| **Trust & Safety Moderation** | **Admin Domain** | Admin reads reported messages **strictly through Evidence Reference tokens** (ADR 0014, ADR 0015). Admin has no general browse access to Work Chat or Candidate Inquiry Conversations. |
| **Conduct Report Chat Access** | **Admin Domain** | Admin may read the Work Chat and Candidate Inquiry history of the reported Quest to evaluate context. Every chat-reading action logs an immutable **`Admin Action`** entry. |
| **Moderation Strikes** | **Admin Domain** | `REPORT_CASE_HIDDEN` and `CONDUCT_REPORT_UPHELD` record confirmed violations on the Misconduct ladder. `REPORT_CASE_RESTORED` writes a linked reversing row in `memberPenaltyRecord` to reverse the strike. |

---

## 4. Admin vs Member & Wallet Boundary

| Responsibility Area | Owning Subsystem | Contract Rule |
| --- | --- | --- |
| **Member Ban Cascading** | **Admin & Wallet** | Banning a Member blocks sign-in and **auto-freezes their Wallet**. Active in-progress Assignments are not force-cancelled; they conclude under standard deadline and submission rules. |
| **Ban Expiry & Wallet Restoration** | **Admin & Wallet** | When a temporary ban expires, the Wallet returns to `ACTIVE` automatically. Discretionary Admin freezes require explicit Admin lifting. |
| **Operational Notifications** | **Admin & Push** | Admin operational actions (Quest Hide, Wallet Freeze, Dispute decisions, Conduct outcomes) send **direct Android Push notifications and in-app alerts** to affected Members only. They never post public System Messages into Work Chat. |

---

## 5. Cross-Subsystem Invariants

1. **Transaction Atomicity**: State transitions that alter member permissions or money reservations must commit their corresponding Chat Membership and Funding Reservation updates in the same database transaction.
2. **Immutability of Terminal Quests**: A Quest in `QUEST_COMPLETED`, `QUEST_CANCELLED`, or `QUEST_FAILED` cannot be reopened by any actor, including Admin.
3. **Audit Completeness**: Every Admin read of private chat evidence and every Admin moderation/settlement decision creates an immutable `Admin Action` or `Audit Record`.
