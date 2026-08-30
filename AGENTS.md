give me a little bit of context, talk in ASD-STE100 Simplified Technical English, and use the ubiquitous language from `CONTEXT.md`.

## Agent skills

### Issue tracker

Issues live in this GitHub repository's Issues. Use the `gh` CLI by default, and link GitHub PRs to their related issue. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the five canonical labels without remapping: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, and `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context repository: read root `CONTEXT.md` and relevant ADRs under `docs/adr/`. See `docs/agents/domain.md`.
Before doing anything related to finance—including diagnosis, design, coding, testing, database work, provider calls, or migrations—read `finace_function.md` completely. It is mandatory guidance for `Top-up`, `Wallet`, `Funding Reservation`, `Ledger Transaction`, `Earnings Conversion`, `Payout`, and `Payout Destination` work.

**Quest rulebook** — for Quest State, Start Work, Proof Submission,
cancellation, failure, or Work Chat membership, read
`docs/quest/work-chat-system-target.md` §Resolved Quest lifecycle before
planning or coding. `docs/deprecated/` is historical evidence, not workflow
authority.

### Clarifying domain context

When a request involves a Quest, Work Chat, Candidate Inquiry Conversation, or
pre-assignment question, identify the active branch before planning or coding.
Read the domain docs first. If the context is still missing, ask for these
facts in this order:

1. The actor: `Hirer`, `Worker`, `Candidate`, `Prospective Worker`, or another
   `Accepted Participant`.
2. The Quest State or Status, using the prefixed values in
   `docs/quest/work-chat-system-target.md`, such as
   `QUEST_ASSIGNED` or `QUEST_IN_PROGRESS`.
3. The Quest mode. Ask for the exact mode from the current contract, for example
   `FIRST_COME_FIRST_SERVED` or `CANDIDATE`. Older documents may call the first
   mode `NO_CANDIDATE`; flag that conflict instead of choosing silently.
4. The participation shape, `SINGLE` or `GROUP`, when completion, proof,
   review, due time, or Reward behavior can differ.
5. `proofRequired` and `dueAt` when the request concerns Sent Work, Proof
   Submission, review, deadline, failure, or Reward settlement.

Ask one missing fact at a time when the user is being interviewed. State the
known context before the question. Do not ask a generic “please give more
context” question.

Example clarification sequence for “แก้ flow ส่งงาน”:

1. “ตอนนี้หมายถึง `Hirer` ที่ตรวจงาน หรือ `Worker` ที่ส่งงาน?”
2. “Quest อยู่ใน State ไหน เช่น `QUEST_ASSIGNED` หรือ
   `QUEST_IN_PROGRESS`?”
3. “Quest mode เป็น `CANDIDATE` หรือ `FIRST_COME_FIRST_SERVED`?”
4. “Quest เป็น `SINGLE` หรือ `GROUP` และ `proofRequired` เป็นค่าใด?”

Use the answers to choose the branch. For example, `Hirer` +
`QUEST_ASSIGNED` points to Quest Edit, while `Worker` +
`QUEST_IN_PROGRESS` points to Sent Work. A `GROUP` Quest can have
partial completion and different failure or Reward results, so do not apply a
`SINGLE` rule without checking the mode and participation shape.
For a `Prospective Worker` + `QUEST_OPEN` request, use the Candidate Inquiry
Conversation contract. Do not treat that Member as a Worker or grant Work
Conversation membership before an `ASSIGNMENT_ACTIVE` Assignment exists.

The clarification is complete only when the relevant actor, Quest State or
Status, mode, and participation shape are known, or the docs prove that a fact
does not affect this request.

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

Behavioral guidelines to reduce common LLM coding mistakes ([source](https://github.com/multica-ai/andrej-karpathy-skills)). Bias toward caution over speed; use judgment on trivial tasks.

**1. Think before coding** — don't assume, don't hide confusion, surface tradeoffs.

- State assumptions explicitly; if uncertain, ask.
- If multiple interpretations exist, present them — don't pick silently.
- If a simpler approach exists, say so; push back when warranted.
- If something is unclear, stop, name what's confusing, ask.

**2. Simplicity first** — minimum code that solves the problem, nothing speculative.

- No features beyond what was asked. No abstractions for single-use code. No unrequested "flexibility". No error handling for impossible scenarios.
- 200 lines that could be 50 → rewrite it.
- Ask: "Would a senior engineer call this overcomplicated?" If yes, simplify.

**3. Surgical changes** — touch only what you must, clean up only your own mess.

- Don't "improve" adjacent code, comments, or formatting. Don't refactor what isn't broken. Match existing style even if you'd do it differently.
- Unrelated dead code: mention it, don't delete it.
- Remove imports/variables/functions YOUR changes made unused; don't remove pre-existing dead code unless asked.
- Test: every changed line traces directly to the user's request.

**4. Goal-driven execution** — define success criteria, loop until verified.

- "Add validation" → write tests for invalid inputs, then make them pass.
- "Fix the bug" → write a test that reproduces it, then make it pass.
- "Refactor X" → ensure tests pass before and after.
- Multi-step tasks: state a brief plan, one line per step with its verify check.

These guidelines are working if: fewer unnecessary changes in diffs, fewer rewrites from overcomplication, clarifying questions come before implementation rather than after mistakes.
