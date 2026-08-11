# Spec: Prepare PR for QA

Status: Decision-complete; ready for skill implementation

## Problem statement

The development workflow produces agent-ready implementation issues in Linear. An implementation agent builds one issue, runs automated feedback loops and code review, then hands it off through `Ready for QA`. A webhook creates a separate immutable verification round on the Tester/QA board. Done is reserved for work that passes required human QA.

The handoff is fragile because the QA issue is created after the implementation context has been discarded. Testers may receive a title and links without a reliable explanation of changed behavior, setup, test data, expected results, edge cases, evidence, or known limitations. The webhook may also create duplicate QA issues when Linear retries a delivery.

The team needs one explicit step that prepares a pull request for human QA while the implementation context, diff and test evidence are still available.

## Goal

Create a reusable `prepare-pr-for-qa` skill that:

1. Verifies that the implementation is ready to be reviewed.
2. Opens or updates a GitHub pull request using repository conventions.
3. Produces a tester-facing QA Brief derived from the Linear issue, code diff and executed verification.
4. Makes that QA Brief available to the Linear webhook without asking the webhook to infer missing requirements.
5. Preserves traceability from Linear implementation issue to pull request to QA verification issue.

## Non-goals

- Replacing Matt Pocock's `implement`, `tdd`, or `code-review` skills.
- Replacing human exploratory or acceptance testing.
- Generating an entire project-level test strategy for every pull request.
- Treating `ready-for-agent` as delivery progress.
- Giving the QA verification issue an additional product estimate.
- Implementing the S-curve dashboard in this change.
- Automatically merging pull requests.

## Shared terminology

- **Implementation issue**: A Linear issue representing one agent-sized vertical slice. It carries the product estimate.
- **QA Brief**: A tester-facing contract generated from the approved issue, actual diff and verification evidence.
- **QA verification issue**: The separate issue created on the Tester/QA team after the implementation issue reaches `Ready for QA`.
- **Source issue ID**: The immutable Linear UUID used to deduplicate and link the QA verification issue.
- **Ready for QA**: Implementation, automated checks, code review and QA Brief are complete. This earns no product progress by itself.
- **QA Pass**: A tester has verified the acceptance criteria and completed the QA verification issue.

## Workflow

```text
grill-with-docs
  -> to-spec
  -> to-tickets
  -> implement
       -> tdd
       -> code-review
       -> prepare-pr-for-qa
            -> validate issue and repository context
            -> validate diff and test evidence
            -> create or update pull request
            -> publish QA Brief
  -> skill validates scheduling fields and moves implementation issue to Ready for QA
  -> Linear webhook creates exactly one linked QA verification issue
  -> Tester executes QA Brief
       -> Pass
            -> source Done and EV earned
       -> Fail
            -> source In Progress + excluded rework bug + new round after fix
```

## Skill invocation

The skill should be explicitly invoked at the end of an implementation session:

```text
/prepare-pr-for-qa BE-123
```

It must not invoke itself automatically merely because a commit exists. Opening or updating a remote pull request is an explicit user action.

## Preconditions

The skill must stop and report a blocker when any required precondition is missing:

- The current branch is not the protected/default branch.
- The referenced Linear issue exists and is an implementation issue.
- The issue contains independently verifiable acceptance criteria.
- The issue carries `Role/Implementation` and `QA Policy/Required`.
- The issue has an Estimate, Project and acceptance due date.
- The due date is at least two business days after the intended `Ready for QA` transition; a late handoff requires an explicit warning but does not move the date.
- The branch has a meaningful diff against its base branch.
- Repository-required lint, typecheck and test commands are known.
- Required automated checks have executed successfully, or failures are disclosed and explicitly accepted by the user.
- GitHub authentication and remote branch configuration are available.
- No secret, credential, debug residue or accidental generated artifact is found in the proposed diff.

The skill must not silently invent acceptance criteria to make an incomplete issue appear ready.

## Source-of-truth precedence

When sources disagree, use this order and report the conflict:

1. Approved Linear implementation issue and its acceptance criteria.
2. Repository `AGENTS.md`, contribution guide and pull request template.
3. Referenced spec, ADRs and domain documentation.
4. Actual branch diff and automated test evidence.
5. Conversation context.

The diff explains what was implemented; it does not have authority to widen the approved scope.

## Required analysis

Before writing the pull request, the skill must:

1. Fetch the full Linear issue, including parent, project, milestone and relations.
2. Identify the base branch and inspect every commit and changed file in the proposed range.
3. Map each acceptance criterion to observable implementation and verification evidence.
4. Identify behavior changes that are not represented in the acceptance criteria.
5. Identify migrations, configuration changes, feature flags, permissions and environment requirements.
6. Determine the smallest useful human QA surface: API, mobile UI, admin UI, integration, migration, or a combination.
7. Distinguish automated verification already completed from manual verification still required.

## Pull request contract

The pull request must contain these sections:

```markdown
## Summary
- User-visible or operational behavior changed
- Why the change is needed

## Linear issue
- Source: BE-123
- Project: <project>
- Milestone: <milestone>

## Acceptance criteria
- [ ] Criterion copied or faithfully restated from the approved issue

## Implementation notes
- Important implementation decisions needed by reviewers
- Migration, configuration or deployment impact

## Automated verification
- Command: `<exact command>` — Pass/Fail
- Command: `<exact command>` — Pass/Fail

## QA Brief
### Scope
What the tester must validate.

### Preconditions
- Environment
- Required account/role
- Required feature flags or services
- Required test data

### Test cases
#### QA-1: <behavior>
1. Action
2. Action

Expected:
- Observable result

### Edge and failure cases
- Case and expected behavior

### Regression focus
- Existing behavior at risk from this change

### Evidence
- Screenshot, response, log or test output link

## Known limitations and out of scope
- Explicit exclusions

## Risk and rollback
- Risk level and reason
- Rollback or recovery notes where relevant
```

Boilerplate sections with no relevant content should say `None` rather than contain invented detail.

## QA test-case quality rules

Each manual test case must contain:

- A stable ID within the PR, such as `QA-1`.
- A single behavior or closely coupled scenario.
- Preconditions and concrete test data.
- Steps written as tester actions, not implementation details.
- An observable expected result.
- Traceability to at least one acceptance criterion.

A test case is invalid if it merely says “works correctly,” requires reading source code to decide whether it passed, or cannot fail against the base commit.

## Pull request creation behavior

- Reuse the repository pull request template when present.
- Derive the title from the user-visible outcome, not the filename list.
- Create a draft PR when required checks or manual evidence remain incomplete.
- Update an existing PR for the current branch rather than create a duplicate.
- Never claim that a check passed unless the command was executed in the current worktree and its exit status was observed.
- Never include secrets or opaque environment values in the PR body.
- Return the PR URL and a concise list of unresolved blockers.
- After the PR and QA Brief are ready, request confirmation before the external Linear status update, then move the source to the configured `Ready for QA` status ID.
- Never move a required-QA source directly to Done.

## Webhook handoff contract

When the implementation issue transitions into the configured `Ready for QA` status, the webhook should:

1. Verify the Linear signature and timestamp.
2. Deduplicate the delivery using `Linear-Delivery`.
3. Confirm the source team is a configured development team.
4. Confirm the source issue requires human QA.
5. Find the linked pull request and its QA Brief.
6. Create exactly one QA verification issue keyed by the immutable source issue UUID.
7. Copy the approved QA Brief without generating new requirements.
8. Link the source issue, PR, project and milestone.
9. Apply `Role/Verification`, inherited `Surface/*` and the Tester/QA team's initial state; copy the source due date exactly.
10. Persist the created QA issue ID against the source issue or in an idempotency store.

Webhook retries must return the already-created QA issue instead of creating another one.

## QA verification issue contract

The generated issue should contain:

- Title: `Verify: <source issue title>`
- Source implementation issue and immutable UUID
- Pull request URL and tested commit SHA
- Project and milestone inherited from the source issue
- QA Brief copied from the pull request
- Acceptance checklist
- Tester, environment and execution timestamp fields
- Pass, fail and blocked result instructions

The QA issue must not carry product story points. Its lifecycle gates the earned value of the source implementation issue.

## Progress semantics

The skill must preserve the approved binary earned-progress contract:

| State | Earned progress |
|---|---:|
| Backlog/Todo/In Progress | 0% |
| `Ready for QA` / QA created / QA in progress / Blocked / Failed | 0% |
| QA Passed and source Done | 100% of source estimate |
| `QA Policy/Exempt` source Done | 100% of source estimate |

The QA verification issue has no product estimate. A generated QA-failure rework bug may have an estimate for workload reporting but must carry machine-readable rework provenance and is excluded from the product S-curve and QA trigger.

## Acceptance criteria

1. Given an approved implementation issue and a valid completed branch, invoking the skill creates or updates one pull request containing all required sections.
2. Every approved Linear acceptance criterion appears in the PR and maps to at least one observable check or an explicitly documented testing gap.
3. Every automated command shown as passed was executed successfully in the current worktree.
4. The QA Brief contains executable manual steps and observable expected results for the changed behavior.
5. Re-invoking the skill on the same branch updates the existing pull request rather than opening another pull request.
6. Missing acceptance criteria, an empty diff, failed required checks or detected secrets block a ready-for-review PR.
7. Moving the source issue to `Ready for QA` causes the webhook to create one linked QA verification issue containing the PR's QA Brief and copied acceptance due date.
8. Re-delivering the same webhook event, or delivering a later retry for the same source issue, does not create a duplicate QA verification issue.
9. The QA verification issue has no product estimate and preserves traceability to the source issue, pull request and tested commit.
10. The skill never moves a required-QA issue directly to Done; human QA pass drives Done and earned progress.
11. A missing Estimate, Project or acceptance due date blocks the handoff.
12. A handoff with fewer than two business days of lead time is explicitly flagged but does not rewrite the due date.

## Testing decisions

- Unit-test payload validation, signature validation, state-transition detection and QA Brief parsing.
- Unit-test idempotency keys using both Linear delivery ID and source issue UUID.
- Integration-test GitHub PR create-versus-update behavior against a stubbed adapter.
- Integration-test Linear issue creation and relation mapping against a stubbed adapter.
- Contract-test representative Linear Issue webhook payloads, including `updatedFrom`.
- End-to-end test a successful `Ready for QA` to QA issue flow in a non-production Linear team/project.
- Replay the same webhook delivery and a distinct retry delivery to prove no duplicate QA issue is created.
- Test failure paths: missing PR, missing QA Brief, failed required check, webhook timeout, Linear API failure and GitHub API failure.

## Observability and operations

Log structured events without secrets:

- Linear delivery ID
- Source issue UUID and identifier
- Pull request number
- QA issue identifier
- Decision: created, reused, skipped, blocked or failed
- Failure category and retryability

The webhook endpoint should acknowledge verified events within Linear's timeout budget. Slow GitHub/Linear work should execute through a durable queue when available.

## Remaining implementation decisions

The lifecycle and progress semantics are approved. Select these adapter details before production rollout:

1. Canonical QA Brief location: PR body, delimited PR comment or committed artifact.
2. Required PR state before the skill may set `Ready for QA`.
3. Who may approve an exception when required automated checks fail.
4. First rollout repositories and development projects.

## Source notes

This design follows the current Matt Pocock build chain: grilling produces decisions, `to-spec` records them, `to-tickets` creates independently verifiable vertical slices, and `implement` drives TDD and code review. It also adopts Linear's signed webhook, previous-value and retry behavior, and tester-facing test-plan practices from the reviewed QA skill references.
