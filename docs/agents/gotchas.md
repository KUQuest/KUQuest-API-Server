# Gotchas

Mistakes agents made in this repo and the rules they produced, so the same failure is not repeated. Newest first. Any agent working here reads this file; any agent may append to it.

## Adding a gotcha

- Add a gotcha when a mistake cost real rework **and** code, tests, or automated checks cannot prevent it recurring on their own.
- Write the rule, not the story: **What happened** (1–2 lines) → **Root cause** (1 line) → **Rule** (imperative, verifiable).
- One topic per entry; search this file first, no duplicates.
- Date every entry. On review, prune entries the codebase or environment has made obsolete — stale rules are worse than none.

## Entries

### 2026-09-15 — Pin a constant revision for unversioned Admin Action resources

**What happened.** When routing Admin Wallet status updates through `walletAdminActionService.executeCommand`, an implementer added an optional `expectedTimestamp?: Date` parameter with branching logic in `prepare` and `apply`. The parameter had no callers, and using `updatedAt` for the request revision would have broken idempotent replays because mutating `updatedAt` on freeze causes `ADMIN_ACTION_KEY_REUSED` on replay.
**Root cause.** Designing for speculative future client timestamps instead of recognizing that unversioned resources need a constant revision sentinel for stable request hashing.
**Rule.** When executing an `AdminAction` command against an unversioned resource, pin a constant revision (`expectedVersion: 1`). Do not introduce optional timestamp or version parameters without an existing client that supplies them.

### 2026-09-15 — Prove a barrel cycle before falling back to internal module paths

**What happened.** An implementer imported Admin Action dependencies from `@/modules/admin/admin-action.service` and `admin-action.policy` rather than the `@/modules/admin` barrel due to an unverified concern about circular dependencies with `@/modules/wallet`. Standards review flagged it as a hard violation of `CODESTYLES.md`, and testing proved the barrel import compiled cleanly with zero cycles.
**Root cause.** Speculative fear of barrel cycles led to an architectural boundary violation without checking if a cycle actually existed.
**Rule.** Always test barrel imports (`bun run typecheck` + `bun test`) before falling back to internal module paths. Only use deep imports when an actual cycle occurs, and document an explicit exception in a guard test.

### 2026-09-15 — Land the shared module before you dispatch its consumers

**What happened.** A shared storage contract was written in the batch context as a TypeScript block, and four implementer subagents were dispatched. Three subagents reported phantom LSP errors waiting for the shared module to appear on disk, and one ran 18 minutes while negotiating typing deviations over `hub` messages.
**Root cause.** A contract in prose cannot be compiled against. Consumers work blind until the producer writes the file, so interface and type mismatches surface late.
**Rule.** Land the shared module with one compiling call site or stub before you dispatch its consumers. Do not dispatch producers and consumers in the same concurrent batch when the contract does not yet compile on disk.

### 2026-09-15 — Derive a subagent's Target list mechanically from search output

**What happened.** An implementer task list retyped a 20-entry grep search result into four prose Target lists. One source file (`src/modules/quest/quest-proof.service.ts`) was dropped during transcription and had to be patched inline mid-flight, while two test files not in any Target list were modified by agents repairing cascade errors.
**Root cause.** Hand-typing file lists from search output drops files and leaves edge cases untracked.
**Rule.** Derive each subagent's Target list mechanically from search results. When a batch partitions a search result across multiple agents, verify that the union of their Target lists equals the search result before dispatch.

### 2026-09-15 — One edit call, two hunks: the second renumbers

**What happened.** Two `CUT` operations in a single edit call against this ledger used ranges numbered on the snapshot the call received. The first cut shifted the file, so the second clipped the neighbouring entry's **Rule** line and left two stale lines dangling mid-entry. Only a `git diff` read before staging caught it; typecheck and the test suite cannot see prose.
**Root cause.** In a multi-operation edit, each range resolves against the file as the previous operation left it, not as the call received it.
**Rule.** Number each later hunk in one edit call against the file after the earlier hunks — or spend one call per hunk. After any multi-hunk edit to prose, read `git diff` before staging.

### 2026-09-15 — Never precompute an Issue number

**What happened.** The branch was named `refactor/545-*` and the claim API pointed at Issue 545 before the Issue existed; `gh issue create` returned #546. The cost was a branch rename and an assign call against a number that did not exist.
**Root cause.** The next issue number was guessed from memory instead of read from the tool that mints it.
**Rule.** Create the Issue first, read its number from the tool response, then claim it and name the branch from that response.

### 2026-09-14 — A raw `sql` template cannot bind a `Date`

**What happened.** The first draft of `readKeysetPage` compared `date_trunc('milliseconds', ${anchor.time.column}) = ${new Date(cursor.startTime)}` inside a raw `sql` template. TypeScript accepted it, and the first test run died inside postgres.js with `ERR_INVALID_ARG_TYPE ... Received an instance of Date`, wrapped in a `DrizzleQueryError` that printed the SQL but not the cause.
**Root cause.** Drizzle applies a column's driver mapper to column references and inserted values, never to a raw template parameter. The raw parameter reaches postgres.js as the JavaScript value, and postgres.js cannot serialise a `Date` where it needs a string.
**Rule.** Bind a timestamp into a raw `sql` template as ISO text with an explicit cast: `${cursor.startTime}::timestamptz`. A green typecheck proves nothing here — a template parameter is `unknown`. See `src/shared/keyset-page.ts`.

### 2026-09-14 — Widening a parameter type means walking the whole caller chain

**What happened.** `listReviews`'s `cursor` parameter widened to `CursorPayload`. The controller that calls the service directly was checked, and the subagent task said no controller edit was needed. `bun run typecheck` then stayed red across two subagent reports until the intermediary — `getProfileReviews` in `src/modules/profile/profile.service.ts`, which forwards to the service and re-declared the old narrow type — was fixed.
**Root cause.** A service can forward another service's call and re-declare the parameter type, so a one-hop check sees the endpoint and misses the middle.
**Rule.** Before widening or narrowing an exported parameter type, run `lsp references` on the symbol and name every caller in the plan or ticket before you dispatch.

### 2026-09-14 — A ticket's file list is not the scope of a defect

**What happened.** #438 fixed one list endpoint that compared a millisecond cursor against a microsecond `created_at`. #446 then fixed five more. A retrospective search for the pattern, instead of a ticket's file list, found five more live sites (Admin Finance, Admin Member, Admin Top-up, Admin Wallet, Admin Dispute queue), which became #537. Three tickets, one bug class, and the class stayed open through two of them.
**Root cause.** Each ticket named files, so each run took the file list as the scope and never asked how many other sites held the same pattern.
**Rule.** When a defect comes from a pattern rather than from one call site, search the repository for the pattern before you plan, and list every site in the ticket. The search includes a module's own internal consumers, not only the files the ticket blames — the import-hub review named twelve importers of the Work Chat port and the repo-wide search found sixteen, four of them v1's own siblings (#546). Then close the class with a guard test that fails when a new site appears, on the `tests/modules/wallet/wallet.money-command.guard.test.ts` pattern: a `Bun.Glob` scan, a path allow-list with a reason per entry, and one `expect(offenders, report).toEqual([])`. A fix without a guard leaves the next site to a future retrospective.

### 2026-09-14 — A green test run does not prove the types compile

**What happened.** A batch contract told four subagents to read Wallet balances through the `getWallet` verb. Each ran its own test files green and reported success. `bun check` then failed with 24 `TS2769` errors across seven files: `getWallet` brands each balance as `Satang` (`number & { __brand: 'Satang' }`), and `expect(balance).toBe(before + 400)` cannot compile against a branded type. The repair was a new fixture plus a mechanical pass over seven files.
**Root cause.** A brand is erased at runtime, so the behaviour a test asserts passes while the type fails. The subagents ran only `bun test`, and a language-server check reported clean on a stale buffer.
**Rule.** A subagent that changes code runs `bun run typecheck` before it reports, not only its own test files: the whole-repository check costs about 10 seconds. A domain verb is the first choice for a test to call, and a branded return type is the reason it can lose to a fixture that returns plain numbers.

### 2026-09-14 — Dispatch subagents into the checkout they already inhabit

**What happened.** Four subagents were dispatched to a separate worktree, with the absolute path in every task and a self-audit in the acceptance criteria. Five partial drafts still landed in the main checkout, and two subagents reported that the edit tool resolved a repository-relative path against their session directory. The next batch of four ran on a branch created in the session checkout itself and produced no stray edit.
**Root cause.** A subagent inherits the session working directory. Path discipline in the task text cannot beat a tool that resolves a relative path against that directory.
**Rule.** Create the branch in the checkout the subagents inherit, and keep a separate worktree for work the dispatcher does alone. When a batch must run in another worktree, the dispatcher reads `git status --short` in the session checkout after every report round and restores the strays from the authoritative copy.

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
**Rule.** Follow the run until completion; never poll with `sleep`. Watch with `gh pr checks <number> --watch` or the `github` device `run_watch` operation. Both stream progress and stop on settlement.

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
