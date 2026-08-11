# Spec: Linear Dev-to-QA Webhook v2

Status: Decision-complete; ready for implementation planning

Related document: `prepare-pr-for-qa-spec.md`

## Problem statement

The workspace separates implementation work into development teams such as Backend and Frontend, and verification work into the Tester/QA team. When a development issue enters the started-category `Ready for QA` status, the replacement webhook creates a separate QA verification round. Dev Done is reserved for work that has passed required human verification.

The current automation needs to be rebuilt because its contract is not sufficiently explicit. A webhook delivery can be retried, an issue can enter Done more than once, source data can be incomplete, and the automation itself creates Linear changes that may emit more webhook events. Without idempotency, provenance and strict transition filtering, the system can create duplicate QA issues, create verification work for the wrong issue type, or lose the relationship between implementation and acceptance.

The new webhook must be a reliable adapter between development completion and human QA. It must copy an already-prepared QA Brief rather than invent testing requirements after implementation context has been lost.

## Goal

Build a production-safe Linear webhook consumer that:

1. Detects an eligible development issue transitioning into the configured `Ready for QA` status ID.
2. Determines whether that issue requires human QA.
3. Creates exactly one linked QA verification issue on the Tester/QA team.
4. Preserves project, milestone, priority, source issue, pull request and tested revision traceability.
5. Copies the canonical QA Brief without generating new requirements.
6. Safely handles webhook retries, replay attempts, repeated `Ready for QA` transitions and partial downstream failures.
7. Drives the approved pass/fail/retest lifecycle without overwriting prior verification rounds.
8. Emits reliable events for a separate S-curve projection worker.

## Non-goals

- Creating or editing pull requests.
- Writing a QA Brief from scratch.
- Running automated tests or human QA.
- Automatically merging code.
- Computing S-curve percentages or forecasts inside the Dev-to-QA worker.
- Assigning product story points to QA verification issues.
- Treating `ready-for-agent` as work completed.
- Replacing Linear project, issue or team workflows.

## Actors and systems

- **Developer or implementation agent**: Completes the implementation issue.
- **Linear**: Source of issue state changes and destination for QA verification issues.
- **Webhook ingress**: Authenticates and durably accepts Linear Issue, Project and Project Update deliveries into one event store.
- **Dev-to-QA processor**: Applies eligibility, idempotency and creation rules.
- **QA lifecycle processor**: Applies Passed, Failed and Blocked outcomes to the source and verification-round history.
- **S-curve projection processor**: Independently builds baseline, scope, PV and EV projections from accepted events.
- **GitHub/PR adapter**: Resolves the linked pull request and canonical QA Brief when required.
- **Tester**: Executes the generated QA verification issue.
- **Operator**: Investigates dead-lettered events and performs controlled replay.

## Shared terminology

- **Source issue**: The Backend or Frontend implementation issue that transitions to `Ready for QA`.
- **Source issue UUID**: Linear's immutable issue ID. This is the primary business idempotency key.
- **Source identifier**: Human-readable identifier such as `BE-72`.
- **QA issue**: The separate issue created in the Tester/QA team, such as `QA-39`.
- **Delivery ID**: The UUID in the `Linear-Delivery` header. This identifies one webhook delivery.
- **Eligible transition**: A source issue moving from any other state into the configured team-specific `Ready for QA` status ID.
- **QA Brief**: The approved tester-facing test contract generated before `Ready for QA`.
- **Processing record**: Durable state recording receipt, decision, attempts and created QA issue.

## High-level flow

```text
Linear Issue update
  -> Webhook ingress
       -> verify raw-body signature
       -> verify timestamp
       -> deduplicate Linear-Delivery
       -> persist accepted event
       -> return HTTP 200 within timeout budget
  -> Durable processor
       -> validate Issue/update event
       -> detect transition into configured Ready for QA status ID
       -> validate source team and QA policy
       -> resolve source issue, PR and QA Brief
       -> acquire sourceIssueId idempotency lock
       -> find or create one QA issue
       -> persist source <-> QA mapping
       -> emit qa-round-created event
  -> QA lifecycle processor
       -> Passed: source -> Done
       -> Failed: source -> In Progress + create excluded rework bug
       -> Blocked: preserve source at Ready for QA
  -> S-curve projection processor
       -> consume Issue, Project, Project Update and QA lifecycle facts
       -> update current scope/EV and daily Asia/Bangkok snapshots
```

## Webhook registration

Configure Linear for `Issue`, `Project` and `Project Update` data-change events. One authenticated ingress and event store serve separate processors.

Preferred rollout:

1. Register Backend and Frontend issue events plus Tester/QA issue events required for verification outcomes.
2. Route by immutable team and status IDs; the Dev-to-QA processor ignores Tester/QA source events while the QA lifecycle processor accepts only mapped verification rounds.
3. Use separate configuration for production and test workspaces.
4. Record the Linear webhook ID and enabled state in operational configuration.

If an organization-wide webhook is used, the application must enforce an explicit allowlist of source team UUIDs and must ignore events created for the Tester/QA team.

## HTTP endpoint contract

### Request

```http
POST /webhooks/linear
Content-Type: application/json
Linear-Delivery: <uuid>
Linear-Event: Issue
Linear-Signature: <hex HMAC-SHA256>
Linear-Timestamp: <unix milliseconds>
```

The handler must retain the exact raw request bytes before JSON parsing.

### Response policy

| Condition | Response |
|---|---:|
| Signature invalid or missing | `401` |
| Timestamp invalid or outside replay window | `401` |
| Malformed JSON or unsupported schema | `400` |
| Verified delivery durably persisted | `200` |
| Verified duplicate delivery already persisted | `200` |
| Temporary failure before durable persistence | `500` |

The endpoint must not wait for GitHub lookups or Linear issue creation before responding. Those actions belong in a durable asynchronous processor.

## Security requirements

1. Compute HMAC-SHA256 over the exact raw request body using the configured Linear webhook signing secret.
2. Compare signatures using a timing-safe comparison.
3. Reject malformed hex signatures before comparison.
4. Validate both the body `webhookTimestamp` and relevant timestamp header when present.
5. Reject requests outside a configurable replay window; default to 60 seconds.
6. Keep webhook secrets and Linear/GitHub credentials outside source control and logs.
7. Use a Linear credential restricted to the minimum required teams and permissions.
8. Never accept an issue/team/project identifier supplied by an unverified caller.
9. Store only the minimum payload data required for replay and audit, subject to the project's retention policy.

IP allowlisting may be used as defense in depth but must not replace HMAC verification because published source IPs may change.

## Accepted payload shape

The processor accepts only events satisfying:

```text
type == "Issue"
action == "update"
data.id is present
data.teamId or resolvable team is present
updatedFrom contains the previous workflow-state identifier
```

The stored envelope must include at least:

- `Linear-Delivery`
- webhook ID
- organization ID
- event type and action
- actor ID/type when present
- webhook timestamp
- source issue UUID
- new serialized issue data
- `updatedFrom`
- receipt timestamp

Payload parsing must tolerate unrelated additional fields.

## Transition detection

Do not compare the display name `Ready for QA`. Team status names are configurable; configure the immutable status ID separately for every development team.

An event is an eligible transition only when:

1. The source issue currently resolves to that team's configured `Ready for QA` status ID, which must belong to the Started category.
2. `updatedFrom` proves the state changed in this event.
3. The previous state ID differs from `Ready for QA`.

If the payload lacks enough state-type information, fetch the current and previous status records by ID. If the previous status cannot be resolved, mark the event `blocked:unresolvable-transition`; do not guess.

Events that update title, labels, assignee or description while the issue is already `Ready for QA` must not create QA work.

## Source eligibility policy

After transition detection, all conditions below must pass:

- Source team UUID is allowlisted as a development team.
- Source issue is not in the Tester/QA team.
- Source issue is not archived or canceled.
- Source project is included in the software-product scope.
- Source carries `Role/Implementation` and does not carry the `qa-failure-rework` provenance marker.
- Source issue is not already a QA verification issue.
- Source carries `QA Policy/Required`; `QA Policy/Exempt` is ineligible and earns EV only when Done.
- Source has an estimate, project and a planned date resolved from its due date or dated milestone.
- Required pull request and QA Brief are available under the selected policy.

### Recommended classification

Use immutable workspace label IDs rather than infer from `ready-for-agent` or label display names:

- `Role/Implementation`: executable source slice.
- `QA Policy/Required`: human QA gates Done and EV.
- `QA Policy/Exempt`: skip verification; require a recorded exemption reason.
- `qa-failure-rework` provenance: workload-only rework generated after a failed round; never creates another QA issue and never contributes independent PV/EV.

Spec/PRD parents are excluded through the immutable `Role/Implementation` label requirement. Parent status alone is insufficient.

## Canonical QA Brief resolution

The webhook must obtain the QA Brief from exactly one configured canonical location. Candidate policies include:

1. A delimited section in the linked GitHub PR body.
2. A machine-addressable PR comment created by `prepare-pr-for-qa`.
3. A committed artifact referenced by the PR.
4. A structured section stored on the Linear source issue.

The processor must not merge conflicting QA Briefs from multiple locations.

When the canonical QA Brief is missing or malformed:

- Do not create a misleading empty QA issue as if it were ready.
- Record `blocked:missing-qa-brief`.
- Add an actionable source-issue comment or operational alert according to configuration.
- Allow controlled retry after the brief is corrected.

## Pull request resolution

The source issue must resolve to the intended pull request through an explicit link or integration record. Do not select a PR merely because its title contains the source identifier.

Required PR facts:

- Repository
- PR number and URL
- Head commit SHA tested by the implementation workflow
- PR state
- QA Brief location/version

The policy for open versus merged PRs is an open decision. The webhook must enforce the selected policy consistently and include the tested commit SHA in the QA issue.

## Idempotency model

Two independent keys are required.

### Delivery idempotency

Unique key:

```text
linear_delivery_id
```

This prevents the same Linear delivery from being processed twice.

### Business idempotency

Unique key:

```text
organization_id + source_issue_uuid + verification_round
```

`verification_round` is one plus the highest durable round already mapped to the source. A later transition back into `Ready for QA` after a Failed round creates a new immutable round against the new tested commit. Repeated deliveries for the same transition reuse the same round.

This prevents duplicate QA issues when:

- Linear sends different deliveries for repeated transitions.
- A worker crashes after Linear creates the QA issue but before the local transaction records success.
- An operator replays an accepted event.
- The source issue is reopened and moved to Done again.

Before creating a QA issue, the processor must search for an existing durable mapping and a destination issue carrying the immutable source marker. If either exists, reconcile and reuse it.

## Processing record state machine

```text
received
  -> ignored
  -> blocked
  -> processing
       -> created
       -> reconciled
       -> retryable-failure
       -> permanent-failure
       -> dead-lettered
```

Each state transition records timestamp, attempt count and reason code.

Recommended reason codes:

- `ignored:not-issue-update`
- `ignored:not-state-transition`
- `ignored:not-dev-team`
- `ignored:already-ready-for-qa`
- `ignored:qa-policy-exempt`
- `ignored:qa-failure-rework`
- `blocked:missing-qa-brief`
- `blocked:missing-pr`
- `blocked:unresolvable-transition`
- `created:qa-issue`
- `reconciled:existing-qa-issue`
- `failed:linear-rate-limit`
- `failed:linear-auth`
- `failed:github-unavailable`
- `failed:invalid-destination-config`

## QA issue creation contract

Create the issue in the configured Tester/QA team with:

| Field | Source |
|---|---|
| Title | `Verify: <source title>` |
| Team | Tester/QA UUID from configuration |
| Initial state | QA team's configured unstarted state |
| Project | Same project as source issue |
| Milestone | Same milestone as source issue when supported |
| Priority | Same priority as source issue |
| Estimate | None |
| Labels | `Role/Verification` plus inherited configured `Surface/*` labels; never `QA Policy/*` |
| Assignee | Unassigned or configured QA routing policy |
| Due date | Exact copy of source due date |

The description must include:

```markdown
## Source
- Implementation issue: <identifier and URL>
- Source UUID: `<uuid>`
- Pull request: <URL>
- Tested commit: `<sha>`
- Project: <project>
- Milestone: <milestone>

## QA Brief
<canonical brief copied verbatim or through a lossless structured rendering>

## Execution
- Tester:
- Environment:
- Started at:
- Result: Pending

## Result policy
- Pass: move this round to configured `Passed` Completed-category status.
- Fail: record evidence and move this round to configured `Failed` Completed-category status.
- Blocked: move this round to configured active `Blocked` status; do not complete it.
```

Add an explicit Linear relation between QA issue and source issue when the chosen relation semantics are decided. Also attach/link the pull request to the QA issue.

## Write ordering and crash recovery

Destination issue creation and local persistence cannot be assumed to share one transaction.

Required sequence:

1. Acquire the business-idempotency lock.
2. Check the local source-to-QA mapping.
3. Search Linear for an existing QA issue carrying the immutable source marker.
4. If found, persist mapping and mark `reconciled`.
5. Otherwise create the QA issue.
6. Immediately persist destination UUID/identifier.
7. Add optional relations, links and comments using idempotent follow-up operations.
8. Mark processing `created` only after required fields and relation are verified.

If the worker crashes after step 5, the next attempt must discover the source marker at step 3 and reconcile rather than create again.

## Retry policy

Ingress relies on Linear's delivery retry only until the event is durably persisted. After persistence, internal processing uses its own retry policy.

Retry internally for:

- Network timeout
- HTTP 429/rate limit
- Linear or GitHub 5xx response
- Temporary queue/storage failure

Do not retry automatically for:

- Invalid credentials
- Missing required configuration
- Missing QA Brief requiring human correction
- Ambiguous pull request
- Source issue classified as ineligible

Use bounded exponential backoff with jitter and a dead-letter threshold. Honor provider retry hints when available.

## Loop prevention

- Dev-to-QA accepts sources only from configured development teams.
- QA lifecycle accepts Tester/QA events only when a durable source-to-round mapping exists.
- Tag or otherwise mark QA issues with immutable automation provenance.
- Ignore events whose actor is the webhook integration when they do not represent an eligible development transition.
- Do not react to integration-authored follow-up events unless they match a different processor's explicit mapped lifecycle transition.

Actor filtering alone must not be the primary protection because a legitimate developer action can be performed through an integration.

## QA outcome and repeated-round behavior

- First eligible `Ready for QA` transition creates verification round 1.
- Passed closes the round, moves the source to Done and records the QA Passed timestamp as the source's earned timestamp.
- Blocked leaves the source at `Ready for QA`; it earns no EV.
- Failed closes that round, moves the source back to In Progress and creates one linked rework bug keyed by the failed QA round.
- The rework bug inherits project, milestone and priority, carries `Role/Implementation`, `Type/Bug`, `QA Policy/Exempt` and machine-readable `qa-failure-rework` provenance. It may carry an estimate for workload reporting but is excluded from product scope, PV/EV and Dev-to-QA eligibility.
- After the source fix, a new transition into `Ready for QA` creates round N+1. Never mutate the tested commit or execution result of an earlier completed round.
- An Urgent or High regression linked to a previously accepted source revokes that source's EV, returns it to In Progress and requires a new verification round. Medium/Low regressions do not revoke EV unless reprioritized.

## Due-date and handoff policy

The source due date is the acceptance deadline. Copy it exactly to every verification round. Dev should enter `Ready for QA` at least two business days earlier, using the workspace work week and `Asia/Bangkok` date boundary.

A late transition still creates the QA issue and preserves the due date. Record `late_handoff=true` and business days of lead time in the processing/audit record; never extend the deadline automatically. Later date changes affect current scope/current plan but never rewrite an immutable S-curve baseline.

## S-curve event and projection contract

The S-curve processor is a separate consumer behind the shared authenticated ingress and event store. Dev-to-QA success must not depend on projection availability, and projection failures must not block QA issue creation.

### Eligible scope and weights

Include issues only from projects labeled `Scope/Product` and only when their role is `Role/Implementation` or `Role/QA Automation`. Exclude `Role/Spec`, `Role/Verification`, parent/summary artifacts and `qa-failure-rework` issues.

Use issue estimates as weights:

```text
project_weight = sum(eligible issue baseline weights)
workspace_weight = sum(project_weight for Scope/Product projects)
```

Do not assign manual project weights or average project percentages. An unestimated eligible issue receives provisional weight 1 only when freezing a baseline under the coverage policy.

### Baseline validation and versioning

Resolve planned date from issue due date, else the assigned milestone target date. There is no project-target fallback. Reject baseline freeze and return the complete issue list if any eligible issue lacks a resolved planned date.

Require estimate coverage of at least 80% by eligible issue count. Store provisional-one decisions explicitly. Baseline versions are immutable and contain issue ID, project ID, role, resolved planned date, estimate/provisional weight, inclusion/exclusion reason, project/milestone dates, creator Project Lead ID, creation timestamp and reason.

Only the current Linear Project Lead may invoke the dashboard rebaseline command. The dashboard must show a diff before confirmation. Permit a new approved baseline when project target/milestone dates change or cumulative scope/estimate weight differs from the active baseline by more than 10%. Preserve Original Baseline and every later approved version.

### PV and EV

At each `Asia/Bangkok` daily boundary:

```text
PV(t) = sum(active baseline weights with planned_date <= t)
EV(t) = sum(current earned weights with earned_at <= t)
progress_percent = EV(t) / current eligible scope weight * 100
```

Earn rules are binary:

- Required implementation: latest verification round Passed and source Done; `earned_at` is the pass event timestamp.
- Exempt implementation: source Done with recorded exemption; `earned_at` is the Done timestamp.
- QA automation: issue Done; `earned_at` is the Done timestamp.
- All other roles and rework: zero independent EV.

Do not award partial progress to In Progress, `Ready for QA`, QA In Progress, Blocked or Failed. If an Urgent/High regression revokes acceptance, record a revocation event so the current EV line may decrease; preserve the earlier earned/revoked history.

### Projection outputs

Maintain per-project and `Scope/Product` workspace projections with:

- Original Baseline PV
- Current Approved Baseline PV
- Current EV
- Current total scope and scope-change history
- Estimate and schedule coverage
- Schedule variance `EV - PV` and SPI `EV / PV` where PV is nonzero
- Late-handoff count
- Open Blocked/Failed rounds and Urgent/High regression count
- Daily snapshots and event-level audit references

## Observability

### Structured logs

- Delivery ID
- Webhook ID
- Organization ID
- Source issue UUID and identifier
- Source team/project/milestone IDs
- Actor type, without unnecessary personal data
- Processing state and reason code
- Attempt number and duration
- PR number and tested commit SHA
- QA issue UUID and identifier

### Metrics

- Accepted webhook count
- Signature/timestamp rejection count
- Duplicate delivery count
- Eligible transition count
- QA issue created count
- Existing QA issue reconciled count
- Blocked count by reason
- Retry and dead-letter count
- End-to-end latency from `Ready for QA` to QA issue ready
- Late-handoff count and lead-time distribution
- QA outcome count by Passed, Failed and Blocked
- S-curve projection lag and failed-event count

### Alerts

- Signature failures exceed threshold
- Queue age exceeds threshold
- Dead-letter event created
- Linear webhook is disabled
- Missing QA Brief rate exceeds threshold
- QA issue creation succeeds but relation/mapping verification fails

## Data retention

Retain:

- Delivery ID and payload hash
- Minimal source transition data
- Processing history
- Source-to-QA mapping
- QA Brief version/hash
- Tested commit SHA

Do not retain access tokens, webhook secrets or full unrelated issue content. Define retention periods before production deployment.

## Configuration

Configuration must identify entities by immutable IDs, not display names:

```text
LINEAR_ORGANIZATION_ID
LINEAR_WEBHOOK_SECRET
LINEAR_DEVELOPMENT_TEAM_IDS
LINEAR_QA_TEAM_ID
LINEAR_QA_INITIAL_STATE_ID
LINEAR_READY_FOR_QA_STATE_IDS
LINEAR_DEV_IN_PROGRESS_STATE_IDS
LINEAR_DEV_DONE_STATE_IDS
LINEAR_QA_PASSED_STATE_ID
LINEAR_QA_FAILED_STATE_ID
LINEAR_QA_BLOCKED_STATE_ID
LINEAR_ROLE_IMPLEMENTATION_LABEL_ID
LINEAR_ROLE_QA_AUTOMATION_LABEL_ID
LINEAR_ROLE_VERIFICATION_LABEL_ID
LINEAR_QA_REQUIRED_LABEL_ID
LINEAR_QA_EXEMPT_LABEL_ID
LINEAR_SCOPE_PRODUCT_PROJECT_LABEL_ID
QA_BRIEF_LOCATION_POLICY
QA_HANDOFF_BUSINESS_DAYS=2
REPORTING_TIMEZONE=Asia/Bangkok
BASELINE_MIN_ESTIMATE_COVERAGE=0.80
REBASELINE_SCOPE_CHANGE_THRESHOLD=0.10
WEBHOOK_REPLAY_WINDOW_MS
INTERNAL_RETRY_LIMIT
```

Secrets must use the deployment platform's secret store rather than committed configuration.

## Acceptance criteria

1. A valid eligible development Issue update that transitions into the configured `Ready for QA` status is durably accepted and processed.
2. Updates while already `Ready for QA` that do not change workflow state do not create QA work.
3. Status detection uses immutable per-team IDs and `updatedFrom`, not the display name.
4. Requests with invalid signatures or stale timestamps are rejected before their payload is processed.
5. A verified delivery is persisted and acknowledged within Linear's timeout budget without waiting for downstream APIs.
6. Replaying the same `Linear-Delivery` produces no additional QA issue.
7. Sending different eligible deliveries for the same source issue and verification round produces no additional QA issue.
8. A crash after destination creation but before mapping persistence is recovered by finding and reconciling the existing QA issue.
9. An eligible source issue with a canonical QA Brief creates one Tester/QA issue containing the source link, PR, tested commit, project, milestone and QA Brief.
10. The generated QA issue has no product estimate.
11. A missing or malformed QA Brief blocks creation with an actionable reason instead of generating testing requirements.
12. QA issue creation cannot recursively trigger another Dev-to-QA creation.
13. Temporary Linear/GitHub failures retry internally; permanent configuration or data errors become blocked or dead-lettered with a stable reason code.
14. Every created or reconciled QA issue has a durable source-to-QA mapping and immutable source marker.
15. Operational logs and metrics allow an operator to answer what happened to any delivery without exposing secrets.
16. A Passed round closes the QA issue, moves its source to Done and records EV at the pass timestamp.
17. A Failed round remains immutable, returns its source to In Progress and creates exactly one excluded rework bug.
18. A later `Ready for QA` transition creates round N+1 without mutating earlier round evidence.
19. QA issue due date exactly matches the source due date and late handoff never extends it.
20. Baseline freeze fails if any eligible issue lacks a due date or dated milestone, or estimate coverage is below 80%.
21. Only the current Project Lead can approve a new baseline version through the dashboard after reviewing a diff and entering a reason.
22. Project and workspace progress aggregate eligible issue weights and do not average project percentages.

## Testing decisions

### Unit tests

- Raw-body HMAC verification and timing-safe comparison
- Timestamp/replay-window validation
- Payload schema parsing with forward-compatible additional fields
- Previous-to-current status transition detection
- Team and issue-role eligibility
- QA exemption policy
- Delivery and business idempotency key generation
- QA issue description rendering
- Retry classification and reason codes

### Contract tests

- Representative Linear `Issue` update webhook payloads
- Payloads with and without `updatedFrom`
- Payloads emitted for non-state updates
- Payloads for integration actors and human actors
- Linear issue-create and relation adapter request/response shapes
- GitHub QA Brief resolution contract

### Integration tests

- Valid event to QA issue creation
- Duplicate delivery reuse
- Different delivery for the same source issue reuse
- Crash-after-create reconciliation
- Missing PR and missing QA Brief blocked flows
- Rate-limit and server-error retries
- QA-team event loop prevention
- Source reopened and completed again
- Passed, Failed and Blocked QA lifecycle events
- Excluded rework bug creation and loop prevention
- Urgent/High regression EV revocation
- Baseline freeze validation, provisional-one estimates and immutable version creation
- Daily Asia/Bangkok PV/EV projection

### End-to-end tests

Run in a non-production Linear project/team:

1. Move one eligible development issue to `Ready for QA`.
2. Confirm one QA issue is created with correct inherited fields and links.
3. Replay the delivery and confirm the count remains one.
4. Fail round 1; confirm source returns to In Progress and one excluded rework bug is created.
5. Move the fixed source to `Ready for QA`; confirm round 2 is created and round 1 remains unchanged.
6. Pass round 2; confirm source becomes Done and EV is recorded at pass time.
7. Use an issue without a QA Brief and confirm an actionable blocked result.
8. Confirm logs, metrics and daily projection contain correlation identifiers.

## Deployment and migration

1. Inventory and disable the old webhook only after its behavior and outstanding deliveries are understood.
2. Deploy v2 in shadow mode: authenticate, persist and classify events without creating QA issues.
3. Compare shadow decisions with manual expectations on real development transitions.
4. Enable creation for one development team/project.
5. Backfill source-to-QA mappings for existing open QA issues before enabling business idempotency broadly.
6. Enable remaining development teams.
7. Disable the old webhook and verify no overlapping registrations remain.
8. Keep a rollback switch that stops destination writes while continuing safe event capture.

## Remaining implementation decisions

These choices do not change the approved lifecycle or progress semantics but must be selected before coding their adapters:

1. Canonical machine-readable QA Brief location.
2. Required pull-request state before `Ready for QA` is accepted.
3. Exact Linear relation/attachment representation in addition to the durable source-round mapping.
4. Processing-record/event-store technology and retention period.
5. Dead-letter replay authorization and first rollout project.

## Source notes

Linear documents webhook delivery as an HTTPS POST with `Linear-Delivery`, `Linear-Event`, `Linear-Signature` and timestamp headers. Update payloads include `updatedFrom`. Linear expects a successful response within five seconds and retries failed deliveries up to three times using delayed backoff. Signature validation uses HMAC-SHA256 over the exact raw body, and Linear recommends rejecting stale timestamps. These behaviors require an at-least-once consumer with durable delivery and business idempotency rather than a single synchronous create-issue handler.
