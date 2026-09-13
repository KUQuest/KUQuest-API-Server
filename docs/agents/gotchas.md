# Gotchas

Mistakes agents made in this repo and the rules they produced, so the same failure is not repeated. Newest first. Any agent working here reads this file; any agent may append to it.

## Adding a gotcha

- Add a gotcha when a mistake cost real rework **and** code, tests, or automated checks cannot prevent it recurring on their own.
- Write the rule, not the story: **What happened** (1–2 lines) → **Root cause** (1 line) → **Rule** (imperative, verifiable).
- One topic per entry; search this file first, no duplicates.
- Date every entry. On review, prune entries the codebase or environment has made obsolete — stale rules are worse than none.

## Entries

### 2026-09-13 — Audit the index, not the working tree

**What happened.** A cutover was audited with `git diff --numstat`, which showed 10 clean files. The commit landed 515 more changed lines, because other changes were already staged. A later `git add -A` also swept three pre-existing untracked documents into a commit, which needed a `git rm --cached` and an amend.
**Root cause.** `git diff` shows the working tree against the index. It hides staged content, and it says nothing about untracked files.
**Rule.** Before you commit, read `git status --short` and `git diff HEAD`. Stage explicit paths. Do not use `git add -A` or `git add .`.

### 2026-09-13 — Read test counts and diffs through the exact output

**What happened.** `bun test tests/modules/wallet tests/modules/quest` reported `0 passed` in the terminal while the log file held 561 passes. `git diff --numstat` returned nothing for a file that was modified. A `prettier --write` call printed a success line that Prettier does not produce.
**Root cause.** The shell tool summarises and filters command output, so a count or a diff can arrive wrong or empty.
**Rule.** Take counts, diffs, and gate results from the log file or from an `eval` cell, not from the summarised shell output. A `0 failed` line you did not read in the log is not evidence.

### 2026-09-13 — An idempotent verb cannot report who did the work

**What happened.** `releaseFundingReservation` became idempotent, so the release pre-check in `quest-lifecycle.worker.ts` looked redundant and was deleted. `tests/modules/quest/quest-dispute-admin.integration.test.ts` then failed: two concurrent worker runs both reported the same released Quest.
**Root cause.** The idempotency contract requires a replay to return the same result as the first operation, so the result cannot say whether this run did the work or replayed it.
**Rule.** Before you delete a pre-check that an idempotent verb makes redundant, find every caller that reads the result as a "this run did the work" signal. Such a caller keeps a state read, or gets a separate signal.

### 2026-09-13 — Start PostgreSQL before the test suite

**What happened.** `bun test` failed deep in a log with a PostgreSQL connection error, because the database container was not running.
**Root cause.** The integration tests need a live PostgreSQL. No check states this prerequisite.
**Rule.** Start the database before a test run, then apply migrations: `podman start kuquest-postgres` (or `podman compose up -d`), then `bun run db:migrate`. This machine has `podman`, not `docker`.
