# Gotchas

Mistakes agents made in this repo and the rules they produced, so the same failure is not repeated. Newest first. Any agent working here reads this file; any agent may append to it.

## Adding a gotcha

- Add a gotcha when a mistake cost real rework **and** code, tests, or automated checks cannot prevent it recurring on their own.
- Write the rule, not the story: **What happened** (1–2 lines) → **Root cause** (1 line) → **Rule** (imperative, verifiable).
- One topic per entry; search this file first, no duplicates.
- Date every entry. On review, prune entries the codebase or environment has made obsolete — stale rules are worse than none.

## Entries

### 2026-09-13 — Keep the inherited migration journal as a prefix

**What happened.** A merge of `develop` put six branch migrations before the inherited `20260910134802_sour_hiroim`, which moved that entry from index 72 to index 78. CI failed with "Inherited migration journal entries are immutable". Two snapshots then shared one `prevId`, so the snapshot chain was forked.
**Root cause.** A journal merge orders by migration timestamp, but `bun run db:check` requires the entries inherited from the base branch to stay an exact prefix of the current journal.
**Rule.** After you merge `develop`, resolve `drizzle/meta/_journal.json` so the inherited entries keep their index and order, and your own migrations follow them. When your migration timestamps are older than an inherited one, rename your migration files to later timestamps, point the first of your snapshots at the inherited head with `prevId`, and copy the inherited schema change into each of your snapshots, so `bun run db:generate` reports no schema change. Renamed files carry new hashes, so every applied database resets: `NODE_ENV=development DEPLOYMENT_ENV=development CONFIRM_LOCAL_DB_RESET="RESET local database" bun run db:reset-local`. Prove the repair with `bun run db:check` and `bun run db:verify-migration-journal`.

**What happened (second case).** A branch merged `develop` and appended its own migration, but its snapshot kept the old `prevId`. Two snapshots then shared one parent snapshot, so the chain stayed forked and `bun run db:generate` failed with a collision error — while `bun run db:check` still exited 0, because `drizzle-kit` prints the collision but exits 0. The proof step above cannot see this failure.

**Rule (added).** After a merge, the snapshot chain stays linear: every snapshot's `prevId` equals the previous snapshot's `id`, and no two snapshots share a parent. For a branch migration that no database has applied, do not repair it by renaming: delete your migration SQL and snapshot, restore `develop`'s `drizzle/meta/_journal.json`, and run `bun run db:generate` from the merged schema.

### 2026-09-13 — Run one integration suite at a time

**What happened.** Two PR worktrees ran `bun check` at once against the shared `kuquest-postgres`. Each suite deleted the other's fixture rows, and both suites failed. Each suite passed when it ran alone.
**Root cause.** Every worktree uses the same database, and the suites share seed users and tables.
**Rule.** Lint, format, typecheck, and build may run in parallel. Run `bun test` in one worktree at a time.

### 2026-09-13 — Pass GitHub text through a file

**What happened.** `gh pr comment --body "$text"` held backticks in the text. Bash ran the spans as command substitution: two posted comments lost every code span, and one substitution ran a full `bun test`.
**Root cause.** Bash runs backticks and `$( )` inside double quotes.
**Rule.** Write long or marked-up bodies to a file and pass `--body-file`. Never build a shell string that holds Markdown.

### 2026-09-13 — Install after you merge in a worktree

**What happened.** A PR worktree kept the `node_modules` from before its merge of `develop`. `bun run format:check` exited 127 because the merged `package.json` added a dependency whose binary was not on disk.
**Root cause.** `git merge` changes `package.json` and `bun.lock` but does not touch `node_modules`.
**Rule.** After a merge that changes `bun.lock`, run `bun install --frozen-lockfile` before you run a gate.

### 2026-09-13 — A root lifecycle script runs in the production install

**What happened.** `"prepare": "husky"` broke the production image. `Dockerfile` runs `bun install --frozen-lockfile --production`, which omits the devDependencies, so the script exited 127 with `husky: command not found`.
**Root cause.** Bun runs the root `prepare` script in every install mode, including the one that installs no devDependency.
**Rule.** A root lifecycle script tolerates a missing devDependency: `"prepare": "husky || true"`. Before you add one, check it against `bun install --frozen-lockfile --production` in a scratch directory that holds only `package.json` and `bun.lock`.

### 2026-09-13 — Watch a GitHub Actions run, do not poll it

**What happened.** Two `sleep 90; gh pr checks` calls spent about four minutes of wall time, then two more `gh run view --log-failed` calls read the failures.
**Root cause.** A sleep guesses the run length, and a passing summary line still needs a second call for the failing log.
**Rule.** Watch a run with the `github` device `run_watch` operation. It follows the run, stops at the first failing job, and saves the full log to an artifact.

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
