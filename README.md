# KUQuest API Server

Welcome to the **KUQuest API Server** — the core backend API for the student mutual-aid and task marketplace platform at Kasetsart University (supporting both the KUQuest Mobile App and KUQuest Admin Web App). Built with **Elysia**, **Bun**, **PostgreSQL**, and **RustFS**.

- 🚀 **Setup & Local Execution Guide:** See [SETUP.md](SETUP.md) for step-by-step instructions.
- 📜 **Business Rules & Specifications:** See [Domain Rulebooks & Architecture](#-domain-rulebooks--specifications).
- 🎮 **Interactive Simulation Suite (120 Scenarios):** Explore [human-read/quest-scenarios.html](human-read/quest-scenarios.html).

---

## 📚 Domain Rulebooks & Specifications

The business logic and system constraints of KUQuest are formally defined in authoritative **Domain Rulebooks** and **Architectural Decision Records (ADRs)**:

```text
docs/
├── rulebook/                  # 🌟 Authoritative Target Policy Rulebooks
│   ├── quest/                 # Quest lifecycle, Work Chat, Proof submissions, and Cancellations
│   ├── admin/                 # Moderation, Dispute resolution, Payout approvals, and Penalty ladders
│   └── finance/               # Double-Entry Ledger, Wallet compartments, and Integer Satang math
├── adr/                       # Architectural Decision Records
├── quest/                     # Quest implementation & reconciliation guide
├── admin/                     # Admin operations reconciliation guide
└── human-read/                # Interactive behavioral simulation suite (HTML)
```

### 1. 📘 Quest & Work Chat Rulebook
- **Primary Source:** [`docs/rulebook/quest/quest-work-chat-rulebook.md`](docs/rulebook/quest/quest-work-chat-rulebook.md)
- **Scope & Highlights:**
  - Complete Quest Lifecycle across all 4 Quadrants (`SINGLE`/`GROUP` × `FIRST_COME_FIRST_SERVED`/`CANDIDATE`).
  - Strict separation of Work Chat and Candidate Inquiry Conversation ([ADR 0019](docs/adr/0019-separate-candidate-inquiry-conversation.md)).
  - Non-approval of proof immediately transitions Quest to failure with zero rework ([ADR 0016](docs/adr/0016-not-approved-proof-fails-quest.md)).
  - Three-Tier Cancellation Matrix (Pre-start: 100% refund, Assigned: 20% worker compensation, In-progress: 100% full payout).
  - 10-Minute Quest Edit Window in `QUEST_ASSIGNED` requiring unanimous worker consent.

### 2. 🛡️ Admin Operations Rulebook
- **Primary Source:** [`docs/rulebook/admin/admin-rulebook.md`](docs/rulebook/admin/admin-rulebook.md)
- **Scope & Highlights:**
  - Manual Admin verification and approval for Payouts ([ADR 0022](docs/adr/0022-manual-admin-approval-for-payouts.md)).
  - Dispute resolution and 7-day money hold for failed quests ([ADR 0024](docs/adr/0024-hold-quest-failure-settlement-for-dispute-window.md)).
  - Moderation Hide: quests are hidden from discovery while escrow and in-progress work remain intact ([ADR 0021](docs/adr/0021-keep-escrow-during-moderation-hide.md)).
  - Wallet Freeze & Suspend mechanics with in-progress commitment protection.
  - Member Penalty Ladders (Misconduct Ladder, Low-Average-Review Ladder, Red Flag, Auto-Freeze).

### 3. 💰 Finance & Wallets Rulebook
- **Primary Source:** [`docs/rulebook/finance/finance-rulebook.md`](docs/rulebook/finance/finance-rulebook.md)
- **Scope & Highlights:**
  - Strict Double-Entry General Ledger with integer Satang accounting ([ADR 0005](docs/adr/0005-integer-satang-for-money.md)).
  - Wallet Compartments (`SPENDING`, `EARNINGS`, `Quest Escrow`, `Funding Reservation`).
  - Immutable financial records and reversing ledger transaction correction pattern ([ADR 0010](docs/adr/0010-retain-and-correct-financial-records.md)).
  - AES-256-GCM encryption for bank account and payout destination secrets ([ADR 0008](docs/adr/0008-encrypt-payout-destination-secrets.md)).

### 4. 📖 Ubiquitous Language & Domain Model
- **Primary Source:** [`CONTEXT.md`](CONTEXT.md)
- Standardized terminology across actors (`Hirer`, `Worker`, `Candidate`), states (`QUEST_OPEN`, `QUEST_ASSIGNED`, `ASSIGNMENT_ACTIVE`, `PROOF_SUBMITTED`), and financial constructs (`Quest Escrow`, `Double-Entry Ledger`, `Remainder Satang`).

---

## 🎮 Interactive Simulation Suite (Human-Readable)

For visualizing end-to-end user journeys, system state machines, double-entry ledger postings, and edge cases:

* **Document File:** [`human-read/quest-scenarios.html`](human-read/quest-scenarios.html) *(or `docs/human-read/quest-scenarios.html`)*
* **Key Features:**
  * 🎯 **120 Comprehensive Scenarios:** Real-world campus stories covering standard workflows, disputes, cancellations, penalties, and concurrent race conditions.
  * 💬 **Interactive Tooltips & Tracing:** Hover over any underlined system code (`QUEST_IN_PROGRESS`, `CONDUCT_OUT_OF_SCOPE`, `PC-11`, `Red Flag`) to view its definition, runtime consequences, and rulebook reference.
  * 📊 **Sequence Diagrams (Mermaid.js):** Step-by-step visual message sequences, API triggers, and double-entry ledger postings.
  * 🎛️ **Multi-Facet Filter Hub:** Filter instantly by Quadrant, Nature, Actors, or Outcome.

Open in your browser:
```bash
xdg-open human-read/quest-scenarios.html
```

---

## 📂 Repository Structure

```text
.
├── docs/                      # Specification, rulebooks, and architectural documentation
│   ├── rulebook/              # Authoritative domain rulebooks (Quest, Admin, Finance)
│   ├── adr/                   # Architectural Decision Records
│   ├── human-read/            # Single canonical simulation HTML document
│   └── db/                    # Database and EDR SQL documentation
├── human-read -> docs/human-read # Symlink for direct document access
├── src/
│   ├── config/                # Typed configuration and environment validation
│   ├── database/              # Drizzle ORM schema and database client
│   ├── modules/               # Feature modules (Auth, Quest, Wallet, Admin, Profile, Onboarding)
│   ├── plugins/               # Cross-cutting Elysia plugins (Error handling, Logging, CORS)
│   ├── app.ts                 # Application route composition
│   └── index.ts               # HTTP startup and runtime initialization
├── scripts/                   # Migration, seeding, background workers, and verification tools
├── tests/                     # Automated test suites (Unit, Integration, Contract)
├── drizzle/                   # Versioned SQL migrations and metadata ledger
├── public/                    # API test bench and static web assets
├── SETUP.md                   # 🚀 Setup, installation, testing, and operations guide
└── CONTEXT.md                 # 📖 Canonical domain vocabulary and Ubiquitous Language
```

---

## 🤝 Contribution & Pull Request Workflow

- **Application, Test, and Documentation PRs:** Create pull requests targeting the **`develop`** branch.
- **GitHub Actions Workflows (`.github/workflows/`):** Any workflow changes must be isolated in a separate pull request targeting the **`main`** branch (see [AGENTS.md](AGENTS.md)).
