# Gotchas

Mistakes agents made in this repo and the rules they produced, so the same failure is not repeated. Newest first. Any agent working here reads this file; any agent may append to it.

## Adding a gotcha

- Add a gotcha when a mistake cost real rework **and** code, tests, or automated checks cannot prevent it recurring on their own.
- Write the rule, not the story: **What happened** (1–2 lines) → **Root cause** (1 line) → **Rule** (imperative, verifiable).
- One topic per entry; search this file first, no duplicates.
- Date every entry. On review, prune entries the codebase or environment has made obsolete — stale rules are worse than none.

## Entries

### 2026-09-14 — Copy `.env` into a new worktree

**What happened.** `bun check` in a second worktree failed one image test with a 503 on a tree that scored 1254 pass / 0 fail in the main checkout. The failure was read as test-data bloat, and the worktree test database was dropped for nothing. The worktree held no `.env`, so `S3_*` carried no value, the presign path threw `ImageLinkUnavailableError`, and the controller answered 503. `cp .env` moved `tests/modules/quest/` from 507 to 508 pass.
**Root cause.** `git worktree add` copies no ignored file, and the image tests only reach the presign path when an earlier file in the same run leaves image rows. So the failure looks like a regression, and it hides when the file runs alone.
**Rule.** After `git worktree add`, copy `.env` from the main checkout and run `bun install --frozen-lockfile`. A gate failure that appears in one worktree and passes in another on the same tree is an environment gap: prove the tree with `git diff --stat <branch-commit> <other-commit>` and re-run the gate in the second checkout before you touch the change. `tests/preload.ts` now names the missing variables, so this failure states its own cause.

### 2026-09-14 — A decision that names two callers holds two claims

**What happened.** ADR-0032 and a map Issue said the Payout path split its idempotency completion across two transactions, like the Top-up path. The Payout code completed in one write at prepare, and the two later writes were dead, because the caller passed `idempotencyKeyId: null`. The wrong half cost two scout dispatches and a re-derived ticket shape before the cutover could start.
**Root cause.** One sentence covered two callers. The Top-up half was true, so the sentence read as verified.
**Rule.** When a decision names more than one caller, verify each caller against code and cite `file:line` for each. A cutover that changes a module also corrects the ADR line that describes it, in the same pull request.

### 2026-09-13 — Claim an Issue through the REST API

**What happened.** `gh issue edit <number> --add-assignee @me` exited 0 for three tickets and assigned nobody. The claim looked complete, and the Issues stayed unassigned.
**Root cause.** This installation accepts the flag, drops the assignment, prints no warning, and returns 0.
**Rule.** Claim an Issue with `gh api repos/KUQuest/KUQuest-API-Server/issues/<number>/assignees -X POST -f "assignees[]=<login>"`, then prove it with `gh issue view <number> --json assignees`. Read your login with `gh api user -q .login`.

### 2026-09-13 — Name the worktree when you dispatch a subagent

**What happened.** A subagent reported a new `CONTEXT.md` glossary entry as written. `git status --short` in the feature worktree showed no change, so a second run landed the entry there. A different draft of the same entry was later found uncommitted in the main checkout, where the subagent had written it.
**Root cause.** A subagent inherits a working directory. When a task names a file by repository path, the subagent can edit the copy in another checkout, and its report still says "written".
**Rule.** Give a subagent the absolute worktree path in its task, and require every path in every tool call to start with it. The rule alone does not hold: it failed twice on the day it was written, because a subagent inherits the session working directory and repository-relative paths resolve there. So both sides verify. The subagent reads `git status --short` in its own worktree and sees its file listed. The dispatcher reads `git status --short` in the main checkout after each report round, and expects no change. A stray edit found there is restored from the pristine copy in the other checkout, then re-applied with absolute paths.

### 2026-09-13 — Copy a path from `git ls-files` before you write it into a ticket

**What happened.** A ticket said the second copy of a protocol lived in `wallet.conversion.service.ts`. That file has never existed: the name came from the test file `wallet.conversion.service.integration.test.ts`. Two subagents were dispatched to one real file, disputed the ownership, and one lost a verified change.
**Root cause.** A test file name, a sibling module's layout, and a docs reference all look like evidence of a source path, and none of them is.
**Rule.** Before a path enters a ticket, a plan, or a subagent task, copy it from `git ls-files <directory>`. When a ticket you receive names a file, check it the same way before you edit, and report the ticket as wrong when the file is absent.

### 2026-09-13 — Take type errors from the worktree, not the language server

**What happened.** `lsp diagnostics` reported `Cannot find module 'drizzle-orm'` for a new file in a second worktree. The package was on disk in that worktree, and `tsc --noEmit` passed.
**Root cause.** One language server serves every worktree and resolves modules from the checkout it started in.
**Rule.** In a worktree other than the one the editor opened, prove types with `bun run typecheck` or `bun check`. A language-server error about a missing module in such a worktree is not evidence.

### 2026-09-13 — Keep the inherited migration journal as a prefix

**What happened.** A merge of `develop` put six branch migrations before the inherited `20260910134802_sour_hiroim`, which moved that entry from index 72 to index 78. CI failed with "Inherited migration journal entries are immutable". Two snapshots then shared one `prevId`, so the snapshot chain was forked.
**Root cause.** A journal merge orders by migration timestamp, but `bun run db:check` requires the entries inherited from the base branch to stay an exact prefix of the current journal.
**Rule.** After you merge `develop`, resolve `drizzle/meta/_journal.json` so the inherited entries keep their index and order, and your own migrations follow them. When your migration timestamps are older than an inherited one, rename your migration files to later timestamps, point the first of your snapshots at the inherited head with `prevId`, and copy the inherited schema change into each of your snapshots, so `bun run db:generate` reports no schema change. Renamed files carry new hashes, so every applied database resets: `NODE_ENV=development DEPLOYMENT_ENV=development CONFIRM_LOCAL_DB_RESET="RESET local database" bun run db:reset-local`. Prove the repair with `bun run db:check` and `bun run db:verify-migration-journal`.

**What happened (second case).** A branch merged `develop` and appended its own migration, but its snapshot kept the old `prevId`. Two snapshots then shared one parent snapshot, so the chain stayed forked and `bun run db:generate` failed with a collision error — while `bun run db:check` still exited 0, because `drizzle-kit` prints the collision but exits 0. The proof step above cannot see this failure.

**Rule (added).** After a merge, the snapshot chain stays linear: every snapshot's `prevId` equals the previous snapshot's `id`, and no two snapshots share a parent. For a branch migration that no database has applied, do not repair it by renaming: delete your migration SQL and snapshot, restore `develop`'s `drizzle/meta/_journal.json`, and run `bun run db:generate` from the merged schema.

### 2026-09-13 — Pass GitHub text through a file

**What happened.** `gh pr comment --body "$text"` held backticks in the text. Bash ran the spans as command substitution: two posted comments lost every code span, and one substitution ran a full `bun test`.
**Root cause.** Bash runs backticks and `$( )` inside double quotes.
**Rule.** Write long or marked-up bodies to a file and pass `--body-file`. Never build a shell string that holds Markdown.

### 2026-09-13 — Install after `bun.lock` changes in a worktree

**What happened.** A PR worktree kept the `node_modules` from before its merge of `develop`. `bun run format:check` exited 127 because the merged `package.json` added a dependency whose binary was not on disk.
**Root cause.** `git merge` changes `package.json` and `bun.lock` but does not touch `node_modules`.
**Rule.** After any operation that changes `bun.lock` — merge, pull, fast-forward, or branch switch — run `bun install --frozen-lockfile` before you run a gate.

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

**What happened (second case).** A `cat > /tmp/body.md <<'EOF' … EOF` heredoc followed by `gh issue create --body-file /tmp/body.md` printed a filtered test-result line, wrote no file, and created no Issue. The call looked like it had run.

**Rule (added).** Write a file with the write tool, and keep the shell for one binary or a short pipeline. A heredoc, a multi-line script, or a command substitution can be dropped without an error.

**Rule (added).** `bun check` writes about 60 KB: 130 ESLint warnings and the whole drizzle table dump sit before the verdict. The shell tool truncates that and can replace it with a summary of its own, so read the verdict from the artifact tail (`read artifact://<id>:-30`) or from an `eval` cell that keeps the last lines of the process output.

### 2026-09-13 — An idempotent verb cannot report who did the work

**What happened.** `releaseFundingReservation` became idempotent, so the release pre-check in `quest-lifecycle.worker.ts` looked redundant and was deleted. `tests/modules/quest/quest-dispute-admin.integration.test.ts` then failed: two concurrent worker runs both reported the same released Quest.
**Root cause.** The idempotency contract requires a replay to return the same result as the first operation, so the result cannot say whether this run did the work or replayed it.
**Rule.** Before you delete a pre-check that an idempotent verb makes redundant, find every caller that reads the result as a "this run did the work" signal. Such a caller keeps a state read, or gets a separate signal.

### 2026-09-13 — Start PostgreSQL before the test suite

**What happened.** `bun test` failed deep in a log with a PostgreSQL connection error, because the database container was not running.
**Root cause.** The integration tests need a live PostgreSQL. No check states this prerequisite.
**Rule.** Start the database before a test run, then apply migrations: `podman start kuquest-postgres` (or `podman compose up -d`), then `bun run db:migrate`. This machine has `podman`, not `docker`.
