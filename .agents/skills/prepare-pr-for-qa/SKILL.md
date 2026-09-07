---
name: prepare-pr-for-qa
description: Prepare an implementation branch for human QA by validating its Linear issue, diff, verification evidence, pull request, and tester-facing QA Brief. Invoke explicitly at the end of an implementation session, for example `/prepare-pr-for-qa BE-123`.
disable-model-invocation: true
---

# Prepare PR for QA

Prepare one implementation issue for the `Ready for QA` handoff. The result is
an accurate pull request, a runnable QA Brief, and a concise list of blockers.

Read the repository's [Prepare PR for QA specification](../../../docs/prepare-pr-for-qa-spec.md)
before executing this skill. It is the source of truth for terminology,
eligibility, webhook handoff, verification-round semantics, and progress rules;
do not duplicate those rules here.

## Operating rules

- Treat the approved Linear implementation issue as the scope authority. The
  diff explains what changed; it cannot widen the issue.
- Use the repository's `AGENTS.md`, contribution guide, pull-request template,
  `CONTEXT.md`, relevant ADRs, and `CODESTYLES.md` as local authority.
- Use the connected Linear integration for the full issue, parent, project,
  milestone, labels, relations, status, and scheduling fields. If it is not
  available, stop with a blocker rather than guessing.
- Invoke remote pull-request creation or update only because this skill was
  explicitly invoked. Never infer that a commit alone authorizes a PR.
- Do not move a Linear issue to `Ready for QA` until the PR and QA Brief are
  complete and the user confirms that external Linear status should change.
- Never move a required-QA issue directly to Done.

## Step 1 — Build the context packet

Resolve the issue identifier from the invocation and fetch the complete Linear
issue. Record:

- approved acceptance criteria and user-visible outcome;
- team, role, QA policy, status, estimate, project, milestone, due date, parent,
  and blocking relations;
- linked pull request, if any;
- relevant domain terms, ADRs, dependencies, and environment requirements.

Inspect the repository and branch:

```bash
git status --short --branch
git symbolic-ref --short refs/remotes/origin/HEAD
git diff <base>...HEAD --stat
git diff <base>...HEAD --name-status
```

Use the repository's protected/default branch as `<base>`. Include committed
and intentional worktree changes in the review, but identify untracked files
explicitly. Stop if the current branch is the protected/default branch, the
issue is not an implementation issue, acceptance criteria are not independently
verifiable, required scheduling/QA fields are missing, or the branch has no
meaningful diff. A late due date is a warning, not permission to rewrite it.

Completion criterion: every required issue, repository, branch, and scheduling
fact is recorded, or each missing fact is reported as a blocker.

## Step 2 — Verify the implementation

Inspect every changed file, including generated files, configuration, migration,
permission, and feature-flag changes. Check for secrets, credentials, debug
residue, accidental artifacts, unrelated scope, and behavior not represented in
the issue.

Discover and run the repository-required lint, typecheck, test, build, and
migration checks. Record each exact command and observed exit status. Never call
a check passed because it is expected to pass. Distinguish:

- automated evidence already executed in this worktree;
- manual QA still required;
- known failures that block the handoff;
- accepted gaps explicitly approved by the user.

Map every acceptance criterion to at least one observable implementation detail
and one verification result. A missing mapping is a blocker or an explicitly
documented testing gap; do not invent acceptance criteria.

Completion criterion: every acceptance criterion and every meaningful behavior
change has an evidence mapping, all required checks have observed results, and
the proposed diff contains no unresolved secret or scope finding.

## Step 3 — Create or update the pull request

Find an existing PR for the current branch before creating one:

```bash
gh pr view --json number,url,state,isDraft,baseRefName,headRefName 2>/dev/null
```

Update that PR when it exists. Otherwise create one with a title describing the
user-visible or operational outcome, not a list of filenames. Use a draft PR
when required checks, manual evidence, or an explicitly accepted gap remains.

Use this body structure and replace every placeholder with observed facts:

```markdown
## Summary
- What changed
- Why it changed

## Linear issue
- Source: <identifier and URL>
- Project: <project or None>
- Milestone: <milestone or None>

## Acceptance criteria
- [ ] <faithful criterion with evidence link or command>

## Implementation notes
- Important decisions
- Migration, configuration, permission, or deployment impact

## Automated verification
- `<exact command>` — Pass/Fail

## QA Brief
### Scope
<Smallest useful human QA surface>

### Preconditions
- <Environment, role, feature flag, and test data>

### Test cases
#### QA-1: <single behavior>
1. <Tester action>
2. <Tester action>

Expected:
- <Observable result>

### Edge and failure cases
- <Concrete case and expected result, or None>

### Regression focus
- <Existing behavior at risk, or None>

### Evidence
- <Screenshot, response, log, or test output, or None>

## Known limitations and out of scope
- <Explicit exclusions, or None>

## Risk and rollback
- Risk: <level and reason>
- Rollback/recovery: <procedure or None>
```

Each QA test case must have a stable `QA-n` ID, concrete preconditions and test
data, tester actions, an observable expected result, and a link to an
acceptance criterion. Keep one behavior per case. Replace irrelevant sections
with `None`; never fill them with invented boilerplate or implementation steps.

Completion criterion: the PR exists exactly once for the branch, contains all
required sections with real values, and its QA Brief can fail against the base
commit without requiring source-code inspection.

## Step 4 — Report and hand off

Return:

- PR URL, state, draft status, base/head branches, and commit under review;
- Linear issue identifier and whether the issue is eligible for `Ready for QA`;
- exact verification commands and results;
- the human QA surface and required preconditions;
- unresolved blockers, testing gaps, late-handoff warnings, and out-of-scope
  behavior.

If the PR or QA Brief is incomplete, leave the source issue unchanged. If both
are ready, ask for confirmation before making the external Linear status change
to `Ready for QA`. After confirmation, apply the configured status and report
the resulting issue state. Do not mark the source Done; the QA verification
round owns that transition.

Completion criterion: the user has a reviewable PR, an executable QA Brief, an
accurate verification record, and a clear statement of anything still blocking
the handoff.
