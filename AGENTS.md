give me a little bit of context, talk in ASD-STE100 Simplified Technical English, and use the ubiquitous language from `CONTEXT.md`.

## Agent skills

### Issue tracker

Issues live in this GitHub repository's Issues. Use the `gh` CLI by default, and link GitHub PRs to their related issue. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the five canonical labels without remapping: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, and `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context repository: read root `CONTEXT.md` and relevant ADRs under `docs/adr/`. See `docs/agents/domain.md`.

**Finance Rulebook** — for `Top-up`, `Wallet`, `Funding Reservation`, `Ledger Transaction`, `Earnings Conversion`, `Payout`, or `Payout Destination`, read `docs/rulebook/finance/finance-rulebook.md` before planning or coding.

**Quest Rulebook** — for Quest State, Start Work, Proof Submission, cancellation, failure, or Work Chat membership, read `docs/rulebook/quest/quest-work-chat-rulebook.md` §Resolved Quest lifecycle before planning or coding.

**Admin Rulebook** — for Payout Approval, Dispute Case, Quest Hide, Wallet Freeze or Suspend, Report Case moderation, Conduct Report, Red Flag, or Member Ban, read `docs/rulebook/admin/admin-rulebook.md` before planning or coding.

**Rulebook routing** — for an authoritative decision table mapping tasks, actors, and states to Rulebooks, sub-contracts, and reconciliation guides, read `docs/agents/routing.md` before planning or coding.

### Clarifying domain context

For a Quest, Work Chat, Candidate Inquiry Conversation, or pre-assignment request, identify the active branch before planning or coding. When the actor, Quest State, mode, or participation shape stays unknown after the domain docs, follow the clarification ladder in `docs/agents/routing.md` §4 and ask for one missing fact at a time.

### Code style

Follow `CODESTYLES.md` at the repo root — formatting, import order, module layout, and Elysia-specific conventions observed in this codebase.

### Workflow

- Idea → sharpened plan: `grilling`/`grill-me` (interview only), `grill-with-docs` (interview + ADR/glossary), `batch-grill-me` (many open questions at once).
- Plan → issue tracker: `to-spec` (synthesis, no interview, one spec issue), `to-tickets` (breaks plan into blocking tracer-bullet tickets).
- Work bigger than one session: `wayfinder` — shared map issue + child ticket issues with blocking edges, resolved one at a time.
- Bug reports / QA: `qa` — conversational bug intake, files issues.
- Issue lifecycle: `triage` — categorises issues/PRs into the five labels above.
- Domain/architecture: `domain-modeling` (terminology, ADRs), `improve-codebase-architecture` (refactor scan).

Typical chain: `grilling`/`grill-with-docs` → `to-spec`/`to-tickets` → `triage` as issues come in → `wayfinder` if scope exceeds one session.

### Pull request and CI/CD workflow rules

- GitHub Actions uses the workflow files from `main`.
- Put application, test, finance, documentation, and other non-workflow changes in a PR with base `develop`.
- If a task changes a file under `.github/workflows/`, commit that workflow change and open a separate PR with base `main`.
- A PR with base `main` must contain only the required GitHub Actions workflow file changes. Do not include application, test, finance, or documentation changes in that PR.
- If one task needs both workflow and non-workflow changes, use separate commits and separate PRs: workflow PR to `main`, other changes PR to `develop`.

### Coding guidelines

Behavioral rules that reduce common LLM coding mistakes: hidden assumptions, speculative abstraction, collateral edits, and unverified work. Read before implementing. See `docs/agents/coding-guidelines.md`.

### Gotchas

Mistakes agents made in this repo and the rules they produced. Read before working; append when a session's failure generalizes. See `docs/agents/gotchas.md`.
