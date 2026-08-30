# Linear Issue Templates and Progress Contract for KUQuest

Status: Draft for team review

Teams/roles covered: Frontend, Backend, Mobile work in Frontend, QA automation in Tester/QA, and Tester/QA manual verification

## Design principles

1. One implementation issue should be an independently demonstrable vertical slice, not merely one technical layer of a larger unfinished change.
2. Acceptance criteria describe observable behavior and must be capable of failing before implementation.
3. Implementation detail is included only where a decision is already settled or an invariant must be preserved.
4. Automated verification and human verification are different contracts.
5. Frontend, Backend and Mobile issues carry implementation estimates. Webhook-generated Tester issues do not carry product estimates.
6. A QA issue designs or implements quality coverage. A Tester issue executes acceptance verification against a specific PR/build/commit.
7. `ready-for-agent` means the issue is sufficiently specified for an implementation agent. It does not mean work has started or earned progress.
8. Parent PRD/spec issues and implementation tickets must be distinguishable to prevent double counting and incorrect webhook triggers.
9. `Ready for QA` is a started-category handoff status. It is not Done and earns no product progress by itself.
10. A `QA Policy/Required` implementation issue earns progress only when its linked verification round passes and the source issue reaches Done.
11. QA-failure rework bugs are workload records, not additional product scope; they are excluded from the S-curve and Dev-to-QA trigger.

## Current workspace audit

The workspace currently has these issue labels:

- `design`
- `bug-found`
- `needs-retests`
- `needs-qa`
- `docs`
- `refactor`
- `feature`
- `bug`

Issues also use `ready-for-agent`, although it was not returned by the current label inventory endpoint. Treat this as an existing workflow dependency that must be reconciled before label cleanup rather than silently recreated or renamed.

Current project labels:

- `Feature`
- `Document`
- `Mobile`
- `Web`

Current teams:

- Backend
- Frontend
- Tester/QA
- Docs

There is no separate Mobile or QA Automation team. Mobile work currently belongs to Frontend, while QA design/automation and manual testing currently share Tester/QA unless the team changes its organization.

### Audit finding

The current flat issue labels mix several independent dimensions:

- Work type: `feature`, `bug`, `refactor`, `docs`, `design`
- QA policy/state: `needs-qa`, `needs-retests`, `bug-found`
- Agent readiness: `ready-for-agent`

This makes filtering and automation ambiguous. For example, `needs-qa` can mean either “this development issue requires QA” or “this QA issue is waiting to be tested.” The revised model separates stable classification from changing workflow state.

## Recommended Linear configuration

Create each as a **team template**, not a workspace template, because team templates can preset team-specific statuses, labels, estimates and sub-issues. Use form templates only for human-created intake where mandatory fields materially prevent incomplete tickets.

| Team | Template | Default labels | Estimate | QA webhook |
|---|---|---|---:|---|
| Frontend | Frontend Implementation | `Role/Implementation`, `Type/Feature`, `Agent State/ready-for-agent`, `QA Policy/Required`, selected `Surface/*` | Required before scheduling | Eligible on `Ready for QA` |
| Backend | Backend Implementation | `Role/Implementation`, `Type/Feature`, `Agent State/ready-for-agent`, `QA Policy/Required` | Required before scheduling | Eligible on `Ready for QA` |
| Mobile work in Frontend | Mobile Implementation | `Role/Implementation`, `Type/Feature`, `Agent State/ready-for-agent`, `QA Policy/Required`, `Surface/Mobile` | Required before scheduling | Eligible on `Ready for QA` |
| QA automation in Tester/QA | QA Design / Automation | `Role/QA Automation`, selected `Test Type/*` only when useful | Required for workload only | Not eligible |
| Tester/QA | Manual Verification | `Role/Verification`, inherited `Surface/*` | None | Destination only |

## Recommended label taxonomy

Linear label groups allow only one child label from a group on an issue. Use a group only when values are genuinely mutually exclusive. Keep cross-cutting values independent when an issue may need more than one.

### 1. Workspace issue-label group: `Role`

Mutually exclusive and required on structured work.

| Label | Meaning | Default teams/templates |
|---|---|---|
| `Role/Spec` | PRD, feature map or decision/spec parent; not executable work | Docs or any team creating specs |
| `Role/Implementation` | Agent/human-sized build slice that can produce a PR | Backend, Frontend, Mobile template |
| `Role/QA Automation` | Test design, automation or QA infrastructure work | Tester/QA QA template |
| `Role/Verification` | Manual acceptance execution against an exact build | Tester/QA webhook destination |

Why workspace-scoped: the webhook, S-curve and multi-team views need the same meaning across Backend, Frontend and Tester/QA.

Do not add `Role/Defect`. A bug that is ready to be fixed is still `Role/Implementation` with `Type/Bug`; a raw bug report remains in triage until it is converted into executable work.

### 2. Workspace issue-label group: `Type`

Migrate the current flat labels into one mutually exclusive group:

| New label | Existing label | Use |
|---|---|---|
| `Type/Feature` | `feature` | New user/domain capability |
| `Type/Bug` | `bug` | Confirmed incorrect behavior to fix |
| `Type/Refactor` | `refactor` | Behavior-preserving design improvement |
| `Type/Docs` | `docs` | Documentation artifact |
| `Type/Design` | `design` | Product/UI/technical design work |
| `Type/Infrastructure` | New | CI/CD, environments, storage, observability or developer infrastructure |

Add `Type/Infrastructure` because current Backend work includes migrations, CI/CD, local object storage and operational tooling that should not be mislabeled as a product feature or refactor.

Do not add separate `chore`, `task`, `enhancement` or `technical-debt` labels yet. They overlap with the types above and add little routing value at the current workspace size.

### 3. Workspace issue-label group: `Agent State`

Use this group only for pre-execution routing. Remove the label when the issue begins implementation if the runner does not do this automatically.

| Label | Meaning |
|---|---|
| `Agent State/needs-triage` | Raw inbound issue not yet classified |
| `Agent State/needs-info` | Missing a decision or fact required for implementation |
| `Agent State/ready-for-agent` | Complete enough for an implementation agent |
| `Agent State/ready-for-human` | Requires human judgment, access or manual action |

These names preserve Matt Pocock's canonical triage roles. If the installed workflow maps roles to different physical label strings, record the mapping in repository agent documentation rather than maintaining two equivalent labels.

Do not use `Agent State` as progress. Status remains the source for Backlog/Todo/In Progress/Done.

### 4. Workspace issue-label group: `QA Policy`

Mutually exclusive on implementation issues only.

| Label | Meaning | Webhook behavior |
|---|---|---|
| `QA Policy/Required` | Human QA must gate delivery | Create a verification round on eligible `Ready for QA` transition |
| `QA Policy/Exempt` | Human QA intentionally bypassed | Skip with recorded exemption reason |

Migrate `needs-qa` to `QA Policy/Required`. Do not apply this group to the generated Tester issue; `Role/Verification` already identifies its purpose.

Require a reason in the issue or approval comment whenever `QA Policy/Exempt` is selected. Exemption should be rare and reviewable.

### 5. Workspace issue-label group: `Surface`

Use on Frontend/Mobile issues and copy it to Tester verification issues. It is optional on Backend issues because the Backend team already supplies the technical ownership dimension.

| Label | Use |
|---|---|
| `Surface/Mobile` | Student-facing mobile application |
| `Surface/Admin Web` | Admin browser application |
| `Surface/Cross-surface` | One approved vertical slice genuinely changes both Mobile and Admin Web |

Do not add `Surface/API`; Backend team membership already represents that ownership, and API behavior can serve multiple product surfaces.

Why keep an issue-level Surface group even though project labels already have Mobile/Web: mixed projects such as Trust & Safety and Wallet & Payments contain separate Mobile and Admin Web issues. Project surface labels cannot identify which surface an individual issue changes.

### 6. Tester/QA team labels: `Test Type` — optional, introduce only when used

Do not preload a large testing taxonomy. Start with labels that change assignment, environment or reporting:

| Label | Use |
|---|---|
| `Test Type/API` | API/contract verification or automation |
| `Test Type/Mobile` | Mobile device/build verification |
| `Test Type/Web` | Browser/admin verification |
| `Test Type/E2E` | Cross-service/user-journey automation |

These values are sometimes multi-dimensional—for example a Mobile E2E test. Therefore, do **not** place them in one mutually exclusive Linear label group if the team needs combinations. In that case keep independent team labels named `test:api`, `test:mobile`, `test:web`, and `test:e2e` instead.

Recommendation for the current team: defer these labels until Tester/QA has enough volume that they materially improve routing. `Role` plus inherited `Surface` is sufficient initially.

## Labels to retire or convert to statuses

| Current label | Recommendation | Reason |
|---|---|---|
| `needs-retests` | Replace with immutable `Failed` verification rounds and a new round after the source is fixed | It is a changing workflow state, not stable classification |
| `bug-found` | Replace with Tester/QA status `Failed` plus linked `Type/Bug` issue | A label does not capture result history or defect relationship |
| `needs-qa` | Migrate to `QA Policy/Required` on source Dev issue | Removes ambiguity between policy and queue state |

Keep the existing labels temporarily during webhook migration. Backfill relations and update the automation before merging/deleting labels.

## Recommended project-label taxonomy

Project labels should describe properties shared by the whole project. Do not repeat issue role, work type, team or workflow state at project level.

### Project label group: `Scope`

Mutually exclusive and required for every project.

| Label | Migrate from | Projects |
|---|---|---|
| `Scope/Product` | `Feature` | Auth & Profile, Admin Infra, Quest Core, Quest Lifecycle, Quest Application & Fulfillment, Wallet & Payments, Trust & Safety, Messaging & Notifications |
| `Scope/Course` | `Document` | Course Deliverables |

This group becomes the reliable inclusion rule for the whole-app S-curve. Do not infer application scope from project names or all projects in the workspace.

### Project surface labels: keep independent

| Label | Projects |
|---|---|
| `Mobile` | Auth & Profile, Quest Core, Quest Lifecycle, Quest Application & Fulfillment, Wallet & Payments, Trust & Safety, Messaging & Notifications |
| `Web` or rename to `Admin Web` | Admin Infra, Wallet & Payments, Trust & Safety |

Do not put Mobile and Web into one mutually exclusive project-label group because Wallet & Payments and Trust & Safety legitimately have both.

Rename `Web` to `Admin Web` only if there is no separate public web product planned. The more precise name prevents testers from confusing the admin surface with a general web client.

### Project labels not recommended

- Domain labels such as Auth, Quest, Wallet or Trust: the project itself already defines the domain.
- Team labels such as Backend or Frontend: project team membership already contains this.
- Phase labels such as MVP, Beta or Final: use milestones or releases.
- Health labels such as At Risk: use project health/status updates.
- Priority labels: use Linear's project priority property.

## Label ownership by scope

| Scope | Labels |
|---|---|
| Workspace issue labels | `Role/*`, `Type/*`, `Agent State/*`, `QA Policy/*`, `Surface/*` |
| Backend team only | No additional labels initially |
| Frontend team only | No additional labels initially; use workspace `Surface/*` |
| Tester/QA team only | Optional independent `test:*` labels after demonstrated routing need |
| Docs team only | No additional labels initially; use `Role/Spec` or `Role/Implementation` with `Type/Docs`/`Type/Design` |
| Project labels | `Scope/*`, plus independent Mobile and Admin Web surface labels |

## Migration order

1. Confirm the exact physical `ready-for-agent` label and repository triage-role mapping.
2. Create `Role`, `Type`, `Agent State`, `QA Policy` and `Surface` workspace groups.
3. Update issue templates to apply the new labels.
4. Update the webhook to use immutable label IDs for `Role/Implementation` and `QA Policy/Required`.
5. Backfill open source issues and existing QA verification issues.
6. Add development status `Ready for QA` in the Started category and Tester/QA statuses `Blocked`, `Passed` and `Failed`; `Passed` and `Failed` are Completed-category outcomes.
7. Create the project `Scope` group and label all projects.
8. Update S-curve filters to include only `Scope/Product`.
9. Run old and new webhook classification in shadow mode and compare decisions.
10. Merge or retire old flat labels only after no active automation depends on them.

## Shared fields outside the description

Every eligible implementation or QA automation issue should set:

- Team
- Project
- Milestone when used for its planned date
- Priority
- Estimate
- Due date, or a milestone whose target date resolves the planned date
- Assignee when scheduled
- Blocking and blocked-by relations
- Parent spec/PRD relation where applicable

Do not duplicate these properties in the description unless the value needs explanation.

## S-curve scheduling and earned-progress contract

### Eligible scope

Include an issue in product scope only when all of the following are true:

- Its project has `Scope/Product`.
- Its role is `Role/Implementation` or `Role/QA Automation`.
- It is not a spec/PRD summary, webhook-generated `Role/Verification` issue, or QA-failure rework bug.

Project weight is derived rather than assigned manually:

```text
project weight = sum(baseline estimate of eligible issues in the project)
workspace weight = sum(project weights for Scope/Product projects)
```

Do not average project percentages. Aggregate points first, then calculate the percentage.

### Planned date and baseline readiness

Resolve each eligible issue's planned date in this order:

1. Issue due date.
2. Target date of the issue's assigned milestone.

There is no project-target fallback. Baseline freeze must fail and list every eligible issue whose planned date remains unresolved.

Baseline freeze also requires estimate coverage of at least 80%, measured as estimated eligible issue count divided by total eligible issue count. Assign a provisional baseline weight of 1 point to each remaining unestimated issue. Replacing a provisional estimate after freeze is a scope/estimate adjustment and must remain visible in history.

The Project Lead alone may approve a baseline. The S-curve dashboard must show the issue/date/estimate diff and require a reason before creating a new immutable baseline version.

### Planned and earned value

Planned Value is cumulative baseline points whose resolved planned date is on or before the reporting date. Use daily boundaries in `Asia/Bangkok`.

Earned Value is binary per eligible issue:

| Issue policy/role | Earn condition |
|---|---|
| `Role/Implementation` + `QA Policy/Required` | Latest verification round is Passed and source issue is Done |
| `Role/Implementation` + `QA Policy/Exempt` | Source issue is Done and the exemption reason is recorded |
| `Role/QA Automation` | QA automation issue is Done |
| `Role/Verification`, `Role/Spec`, QA-failure rework | Never contributes independent EV |

Do not assign partial EV for In Progress, `Ready for QA`, QA in progress, or Failed. Project and workspace progress reach 100% when eligible EV equals eligible current scope.

### QA handoff timing

The source due date represents the acceptance deadline. A source issue must enter `Ready for QA` at least two business days before that date. A later transition still creates the QA issue and copies the original due date, but records `late handoff`; it must not silently move the deadline.

### Scope change, regression and rebaseline

Preserve Original Baseline and every approved later version. Never rewrite a prior baseline when dates, estimates or scope change.

A Project Lead may create a new baseline version through the S-curve dashboard when either condition applies:

- Project target or milestone dates change.
- Cumulative scope/estimate weight differs from the active baseline by more than 10%.

The dashboard must show Original Baseline, Current Approved Baseline, Actual/EV and scope history. An `Urgent` or `High` regression linked to an accepted source revokes that source's EV until its new verification round passes. Medium/Low defects remain tracked without revoking earned progress unless reprioritized.

---

# Template 1: Frontend Implementation

Recommended title:

```text
<User-visible behavior or UI outcome>
```

Avoid titles such as `Create component`, `Fix UI`, or `Frontend for BE-123` unless they describe a complete demonstrable slice.

Recommended defaults:

- Team: Frontend
- Status: Backlog or Todo according to team policy
- Labels: `Role/Implementation`, `Type/Feature`, `Agent State/ready-for-agent`, `QA Policy/Required`, one selected `Surface/*`
- Estimate: Required before scheduling
- Project and milestone: Required

Template body:

```markdown
## Outcome

<!-- Describe what a user can now see or do. One concise paragraph. -->

## User story

As a **<role>**, I want to **<action>**, so that **<outcome>**.

## Context

- Parent spec/PRD: <!-- Linear issue -->
- Related design: <!-- Figma frame or design document -->
- API contract: <!-- Backend issue/OpenAPI/reference -->
- Existing behavior: <!-- What happens before this change -->

## Scope

### In scope

- <!-- Behavior owned by this issue -->

### Out of scope

- <!-- Explicitly excluded behavior -->

## User flow and states

### Primary flow

1. <!-- User action -->
2. <!-- UI response -->
3. <!-- Observable outcome -->

### Required states

- Loading: <!-- Expected presentation and interaction -->
- Empty: <!-- Expected presentation -->
- Error: <!-- Message/recovery action -->
- Success: <!-- Expected result -->
- Unauthorized/forbidden: <!-- If applicable -->
- Offline/degraded: <!-- If applicable -->

## Acceptance criteria

- [ ] Given **<precondition>**, when **<action>**, then **<observable result>**.
- [ ] Given **<failure/edge condition>**, when **<action>**, then **<observable recovery behavior>**.
- [ ] Keyboard and focus behavior is observable and usable where applicable.
- [ ] Layout behaves correctly at the agreed breakpoints.

## Design contract

- Figma frame/version: <!-- Exact frame -->
- Breakpoints: <!-- e.g. mobile/tablet/desktop -->
- Components/design tokens to reuse: <!-- Existing system -->
- Intentional deviations: <!-- None or explicit deviations -->

## Data and API contract

- Endpoint/query: <!-- Method/path or client operation -->
- Required request fields: <!-- Only relevant fields -->
- Success response used by UI: <!-- Relevant shape -->
- Error mapping: <!-- API condition -> user-visible response -->
- Cache/revalidation behavior: <!-- If applicable -->

## Analytics and accessibility

- Analytics events: <!-- Event name + trigger, or None -->
- Accessible name/role expectations: <!-- If applicable -->
- Screen-reader announcement: <!-- If applicable -->
- Reduced motion/contrast requirements: <!-- If applicable -->

## Testing decisions

- Unit/component seam: <!-- Behavior tested -->
- Integration seam: <!-- Boundary tested -->
- E2E/manual seam: <!-- User journey tested -->
- Regression focus: <!-- Existing behavior at risk -->

## Demo path

<!-- A reviewer can perform these steps and observe the completed slice. -->

1. <!-- Setup -->
2. <!-- Action -->
3. <!-- Expected result -->

## Definition of Done

- [ ] Acceptance criteria pass.
- [ ] Required automated checks pass.
- [ ] Loading, empty, error and success states are implemented where relevant.
- [ ] PR includes screenshots/video for visible changes.
- [ ] PR contains a QA Brief.
- [ ] Known limitations and out-of-scope behavior are documented.
- [ ] Issue has entered `Ready for QA`; do not mark it Done until the linked verification passes.
```

Frontend-specific rejection checks:

- Reject if no design/reference exists and visual decisions remain open.
- Reject if the ticket says only “connect API” without a user-visible outcome.
- Reject if loading/error/empty states are applicable but unspecified.
- Reject if acceptance criteria depend on unfinished work owned by another ticket without a blocking relation.

---

# Template 2: Backend Implementation

Recommended title:

```text
<Domain behavior>: <API/event/operation>
```

Example shape:

```text
A Giver can publish a valid Draft: POST /api/v1/quests/:id/publish
```

Recommended defaults:

- Team: Backend
- Status: Backlog or Todo
- Labels: `Role/Implementation`, `Type/Feature`, `Agent State/ready-for-agent`, `QA Policy/Required`
- Estimate: Required before scheduling
- Project and milestone: Required

Template body:

```markdown
## Outcome

<!-- Describe the domain capability delivered by this issue. -->

## Actor and authorization

- Actor: <!-- Role/service -->
- Authentication required: <!-- Yes/No and mechanism -->
- Authorization rule: <!-- Who may perform/read this operation -->
- Ownership boundary: <!-- How ownership is enforced -->

## Context

- Parent spec/PRD: <!-- Linear issue -->
- Related issues: <!-- FE/Mobile/Admin/dependency -->
- Domain terms/ADR: <!-- Relevant durable source -->
- Existing behavior: <!-- Current API/system behavior -->

## Scope

### In scope

- <!-- Complete vertical behavior owned here -->

### Out of scope

- <!-- Explicit exclusions -->

## API or event contract

- Operation: `<METHOD /path>` or `<event name>`
- Request/input: <!-- Relevant fields and validation -->
- Success result: <!-- Status and response semantics -->
- Failure results: <!-- Condition -> status/domain error -->
- Idempotency/retry semantics: <!-- If applicable -->
- Pagination/filter/order semantics: <!-- If applicable -->

## Domain rules and invariants

- <!-- Rule that must always hold -->
- <!-- State transitions allowed/refused -->
- <!-- Concurrency or money/security invariant -->

## Data contract

- Schema changes: <!-- Tables/columns/constraints or None -->
- Migration/backfill: <!-- Forward/rollback/recovery expectations -->
- Transaction boundary: <!-- What must commit atomically -->
- External services/storage: <!-- Dependencies and failure behavior -->
- Sensitive data: <!-- Handling/logging restrictions -->

## Acceptance criteria

- [ ] Given **<authorized state>**, when **<request/event>**, then **<observable response and persisted effect>**.
- [ ] Given **<invalid input>**, when **<request>**, then **<specific error>** and no forbidden side effect occurs.
- [ ] Given **<unauthorized/forbidden actor>**, access is refused without leaking protected information.
- [ ] Given **<retry/concurrent request>**, the selected idempotency or conflict behavior is observed.

## Testing decisions

- Primary seam: <!-- Highest stable interface to test -->
- Unit tests: <!-- Only isolated domain logic where justified -->
- Integration tests: <!-- Database/service boundary -->
- Contract tests: <!-- Request/response/event schema -->
- Security tests: <!-- Auth, ownership, validation -->
- Regression focus: <!-- Existing behavior at risk -->

## Observability

- Logs: <!-- Required structured events; no secrets -->
- Metrics/traces: <!-- If applicable -->
- Operational failure signal: <!-- How failure is detected -->

## Demo path

1. <!-- Setup data/auth -->
2. <!-- Exact request or trigger -->
3. <!-- Expected response/state -->

## Definition of Done

- [ ] Acceptance criteria pass.
- [ ] Migration/recovery behavior is verified where applicable.
- [ ] Required automated checks pass.
- [ ] API/event documentation is updated when the contract changes.
- [ ] PR contains exact verification commands and QA Brief.
- [ ] No secret or sensitive data is exposed in logs/errors.
- [ ] Issue has entered `Ready for QA`; do not mark it Done until the linked verification passes.
```

Backend-specific rejection checks:

- Reject if authorization and ownership rules are unspecified.
- Reject if persistence effects are described without transaction/failure semantics where correctness depends on them.
- Reject if the issue is only a schema layer that cannot be demonstrated independently, unless it is an approved expand-contract refactor.
- Reject if error behavior is “return appropriate error” without an observable contract.

---

# Template 3: Mobile Implementation

Recommended title:

```text
<User journey outcome> on mobile
```

Recommended defaults:

- Team: Frontend (there is currently no separate Mobile team)
- Status: Backlog or Todo
- Labels: `Role/Implementation`, `Type/Feature`, `Surface/Mobile`, `Agent State/ready-for-agent`, `QA Policy/Required`
- Estimate: Required before scheduling
- Project and milestone: Required

Template body:

```markdown
## Outcome

<!-- Describe the complete mobile user outcome. -->

## User story

As a **<mobile user role>**, I want to **<action>**, so that **<outcome>**.

## Context

- Parent spec/PRD: <!-- Linear issue -->
- Figma flow/frame: <!-- Exact reference -->
- Backend/API dependency: <!-- Issue/contract -->
- Supported platforms: <!-- Android/iOS/both -->
- Minimum OS/app version: <!-- If relevant -->

## Scope

### In scope

- <!-- Journey owned by this issue -->

### Out of scope

- <!-- Explicit exclusions -->

## Navigation and lifecycle

- Entry point: <!-- Route/screen/deep link -->
- Success destination: <!-- Route/screen -->
- Back behavior: <!-- System/app back -->
- App background/foreground behavior: <!-- State preservation -->
- Process restart behavior: <!-- Persisted/recovered state -->

## Required UI states

- Initial/loading
- Empty
- Error and retry
- Success
- Offline/degraded network
- Permission denied
- Session expired

Describe only applicable states and remove the rest explicitly.

## Device and interaction requirements

- Screen sizes/orientations: <!-- Supported cases -->
- Keyboard behavior: <!-- Resize/scroll/focus -->
- Safe areas/system bars: <!-- Expectations -->
- Touch target and gesture behavior: <!-- Expectations -->
- Accessibility: <!-- Semantics, scaling, screen reader -->
- Localization/timezone/date/number behavior: <!-- If applicable -->

## Data, cache and synchronization

- API operations: <!-- Relevant endpoints -->
- Local state/cache: <!-- What persists and for how long -->
- Offline behavior: <!-- Read/write/queue/refuse -->
- Retry and duplicate-submit behavior: <!-- Contract -->
- Conflict behavior: <!-- If local and remote differ -->

## Acceptance criteria

- [ ] Given **<device/app state>**, when **<user action>**, then **<observable result>**.
- [ ] Given a slow or unavailable network, the user sees **<state>** and can **<recover>**.
- [ ] Given backgrounding/restart at **<point>**, the selected state-preservation behavior occurs.
- [ ] Given permission denial/session expiry, the app responds without trapping or losing unrelated user data.
- [ ] Text scaling and screen-reader navigation remain usable for the changed flow.

## Testing decisions

- Unit/widget tests: <!-- State and rendering behavior -->
- Integration tests: <!-- Navigation/API/storage -->
- Device/E2E tests: <!-- Critical journey -->
- Manual device matrix: <!-- Minimum set -->
- Regression focus: <!-- Existing flow at risk -->

## Demo path

1. Install/open build `<identifier>`.
2. Use account/data `<fixture>`.
3. Perform `<actions>`.
4. Observe `<result>`.

## Definition of Done

- [ ] Acceptance criteria pass on the agreed device matrix.
- [ ] Loading/error/offline/lifecycle states are handled where applicable.
- [ ] Required automated checks pass.
- [ ] PR contains screenshots or screen recording.
- [ ] Build/commit tested by QA is identifiable.
- [ ] PR contains QA Brief and test data instructions.
- [ ] Issue has entered `Ready for QA`; do not mark it Done until the linked verification passes.
```

Mobile-specific rejection checks:

- Reject if the exact build, platform or device assumptions needed for verification are unknowable.
- Reject if the happy path is specified but offline, permission or lifecycle behavior materially affects the flow and remains undecided.
- Reject if a UI-only ticket cannot be demonstrated without an unstated API dependency.

---

# Template 4: QA Design / Test Automation

Purpose: Use for quality engineering work created before or alongside implementation—for example risk analysis, contract tests, Playwright/Appium coverage, regression-suite maintenance or test-data infrastructure. Do not use this template for the webhook-generated manual verification of a finished Dev issue.

Recommended title:

```text
QA: <Quality capability or coverage outcome>
```

Recommended defaults:

- Team: Tester/QA (there is currently no separate QA Automation team)
- Labels: `Role/QA Automation`; add independent `test:*` labels only when they materially improve routing
- Estimate: Required for workload planning
- QA webhook: Exempt

Template body:

```markdown
## Quality objective

<!-- What risk or confidence gap this work addresses. -->

## Source and traceability

- Feature/spec: <!-- Linear issue/project -->
- Implementation tickets covered: <!-- Issues -->
- Requirements/acceptance criteria covered: <!-- IDs or exact references -->
- Existing test assets: <!-- Suite/files/dashboard -->

## Risk assessment

| Risk | Likelihood | Impact | Coverage response |
|---|---|---|---|
| <!-- Risk --> | Low/Med/High | Low/Med/High | <!-- Test/monitor/gate --> |

## Scope

### In scope

- <!-- Test levels and behaviors -->

### Out of scope

- <!-- Explicit exclusions with reason -->

## Test approach

- Test level: <!-- Unit/integration/contract/E2E/manual/non-functional -->
- Test type: <!-- Functional/regression/security/performance/accessibility -->
- Environment: <!-- Required services/configuration -->
- Test data: <!-- Fixtures/accounts/privacy constraints -->
- Tool/framework: <!-- Existing preferred tool -->
- Execution trigger: <!-- PR/merge/nightly/manual/release -->

## Coverage matrix

| Requirement/behavior | Positive | Negative | Boundary | Recovery | Automated/manual |
|---|---:|---:|---:|---:|---|
| <!-- Behavior --> | Yes/No | Yes/No | Yes/No | Yes/No | <!-- Type --> |

## Acceptance criteria

- [ ] Every in-scope requirement maps to an executable test or an explicit accepted gap.
- [ ] The test fails against the known-bad/base behavior and passes against the intended behavior where applicable.
- [ ] Failures produce actionable evidence without exposing secrets or personal data.
- [ ] Flake/retry policy does not hide deterministic failures.
- [ ] Test runtime and environment cost fit the selected execution trigger.

## Quality gates

- Entry criteria: <!-- What must exist before execution -->
- Pass criteria: <!-- Measurable gate -->
- Block/release criteria: <!-- What prevents delivery -->
- Escalation owner: <!-- Role/person -->

## Deliverables

- [ ] Test cases/specification
- [ ] Automated tests where in scope
- [ ] Fixtures/test data
- [ ] CI integration
- [ ] Result/report location
- [ ] Maintenance owner/documentation

## Definition of Done

- [ ] Coverage matrix is traceable and reviewed.
- [ ] Tests execute in the target environment.
- [ ] Known failure and pass behavior are demonstrated.
- [ ] Results are visible to the development and Tester teams.
- [ ] Remaining risks and manual checks are documented.
- [ ] Issue is Done; this timestamp earns its independent QA automation estimate.
```

QA-specific rejection checks:

- Reject if the issue only says “test feature X” without naming risks or required confidence.
- Reject if a test cannot demonstrate a known failure condition.
- Reject if automation duplicates implementation-unit tests without adding coverage at a useful seam.
- Reject if pass/fail criteria are subjective or unobservable.

---

# Template 5: Tester Manual Verification

Purpose: This is the destination contract for the Dev-to-QA webhook. The webhook fills most fields from the source implementation issue and PR QA Brief. A tester should not have to reconstruct requirements from code or chat history.

Recommended title:

```text
Verify: <Source implementation issue title>
```

Recommended defaults:

- Team: Tester/QA
- Status: QA queue/Todo
- Labels: `Role/Verification`, inherited `Surface/*`; do not apply `QA Policy/*`
- Estimate: None
- Project/milestone/priority: Inherit from source
- Due date: Apply only the approved QA scheduling policy

Template body:

```markdown
## Source

- Implementation issue: <!-- Identifier + URL -->
- Source UUID: `<!-- Immutable Linear UUID -->`
- Pull request: <!-- URL -->
- Tested commit/build: `<!-- SHA/build ID -->`
- Project: <!-- Inherited -->
- Milestone: <!-- Inherited -->

## Verification objective

<!-- One paragraph describing the behavior the tester is accepting. -->

## Preconditions

- Environment: <!-- Staging/local/device -->
- App/build version: <!-- Exact identifier -->
- Account/role: <!-- Required role -->
- Feature flags/configuration: <!-- Required values, no secrets -->
- Test data: <!-- Fixtures/setup -->

## Acceptance checklist

- [ ] <!-- Criterion from approved source issue -->
- [ ] <!-- Criterion from approved source issue -->

## Test cases

### QA-1: <Primary behavior>

Priority: Critical/High/Medium/Low

Preconditions:

- <!-- Specific precondition -->

Steps:

1. <!-- Tester action -->
2. <!-- Tester action -->

Expected:

- <!-- Observable expected result -->

Evidence:

- <!-- Screenshot/video/response/log -->

### QA-2: <Failure or edge behavior>

Priority: <!-- Priority -->

Preconditions:

- <!-- Specific precondition -->

Steps:

1. <!-- Tester action -->

Expected:

- <!-- Observable failure/recovery result -->

Evidence:

- <!-- Evidence -->

## Regression focus

- <!-- Existing adjacent behavior that must remain intact -->

## Known limitations and out of scope

- <!-- Copied from source/PR; do not invent -->

## Execution record

- Tester: <!-- Assignee -->
- Started at: <!-- Timestamp -->
- Environment/build actually tested: <!-- Exact value -->
- Result: Pending / Pass / Fail / Blocked

## Result notes

### Pass

- Evidence: <!-- Links/attachments -->
- Completed at: <!-- Timestamp -->

### Fail

- Failed test case: <!-- QA-ID -->
- Actual result: <!-- Observable behavior -->
- Expected result: <!-- Expected behavior -->
- Reproduction rate: <!-- e.g. 3/3 -->
- Evidence: <!-- Attachment -->
- Defect/retest issue: <!-- According to team policy -->

### Blocked

- Blocker: <!-- Missing environment/data/build/access -->
- Owner needed: <!-- Team/person -->
- Next action: <!-- Actionable step -->

## Completion policy

- Mark the verification round `Passed` only when all required acceptance criteria pass on the recorded build. The webhook then moves the source issue to Done.
- Do not mark Done when execution is blocked.
- On failure, mark this round `Failed` in the Completed category. The webhook returns the source to In Progress and creates a linked rework bug.
- Never reuse or overwrite a completed verification round. A later `Ready for QA` transition creates the next round against the new tested commit.
```

Tester-specific rejection checks:

- Block execution if build/commit, environment or required test data is missing.
- Block execution if expected results require guessing.
- Do not accept a PR merely because automated tests pass.
- Do not edit the acceptance criteria to match implemented behavior; escalate the mismatch.

---

# Separate Bug / Defect Template

Although not one of the five requested roles, QA failures need a consistent defect artifact. The webhook creates this as a rework record linked to the source and failed verification round.

Generated defaults:

- Labels: `Role/Implementation`, `Type/Bug`, `QA Policy/Exempt`; carry a machine-readable `qa-failure-rework` provenance marker.
- Project and milestone: inherited from the source.
- Estimate: required for workload reporting; excluded from product PV/EV and project weight.
- QA webhook: ineligible. Retest occurs through the source issue's next verification round.

```markdown
## Summary

<!-- Observed failure in one sentence -->

## Found during

- QA issue: <!-- QA-xx -->
- Source implementation issue: <!-- FE/BE/Mobile -->
- PR/build/commit: <!-- Exact revision -->
- Environment/device: <!-- Exact context -->

## Reproduction

### Preconditions

- <!-- Setup -->

### Steps

1. <!-- Action -->

## Expected

<!-- Observable expected behavior -->

## Actual

<!-- Observable actual behavior -->

## Evidence

- <!-- Screenshot/video/log/response -->

## Frequency and impact

- Reproduction rate: <!-- e.g. 5/5 -->
- Severity: Critical/High/Medium/Low
- User/business impact: <!-- Impact -->
- Workaround: <!-- None or steps -->

## Regression information

- Last known good build: <!-- If known -->
- First known bad build: <!-- If known -->
```

# Template selection rules

| Situation | Template |
|---|---|
| Agent-sized web UI behavior | Frontend Implementation |
| Agent-sized API/domain behavior | Backend Implementation |
| Android/iOS journey | Mobile Implementation |
| Design or implementation of test coverage | QA Design / Test Automation |
| Execute acceptance against a finished Dev build | Tester Manual Verification |
| Report a failure found during verification | Bug / Defect |
| Broad feature decision/spec | None of these; use a spec/PRD template with `Role/Spec` |

# Workflow relationship

```text
Spec/PRD (`Role/Spec`)
  -> to-tickets
       -> FE / BE / Mobile implementation (`Role/Implementation`)
            -> implement + TDD + code review
            -> prepare PR with QA Brief
            -> Ready for QA (at least 2 business days before acceptance due date)
                 -> webhook
                      -> Tester verification (`Role/Verification`)
                           -> Pass -> source Done
                           -> Fail -> source In Progress + excluded rework bug

QA design/automation (`Role/QA Automation`) may run before or alongside implementation.
```

Revised lifecycle:

```text
Implementation -> In Progress -> Ready for QA
  -> webhook creates Verification round N with copied source due date
       -> Passed -> source Done -> source estimate earns EV
       -> Blocked -> source remains Ready for QA -> no EV
       -> Failed -> close round -> source In Progress -> linked rework bug
            -> fix source -> Ready for QA -> create round N+1
```

# Remaining operational decisions

1. Will Mobile remain in Frontend permanently or become a dedicated Linear team later?
2. Will QA automation remain in Tester/QA or become a separate team later?
3. What is the exact physical `ready-for-agent` label and how is Matt Pocock's triage role mapped to it?
4. What makes an issue agent-ready: template completion, triage approval, or `to-tickets` output?
5. Which repositories and projects are included in the first webhook rollout?
6. Should project label `Web` be renamed to `Admin Web`, or is a public web product planned?
7. Which sections should remain in English for agent consistency and which should be Thai for the team?

# Source notes

Linear supports workspace, team and form issue templates. Team templates can preset team-specific properties, while form templates can require structured inputs. Linear also supports parent/sub-issue inheritance and team-level parent/sub-issue status automation. These templates use team scope because each role needs different default labels, statuses and estimate behavior.

The implementation templates follow the vertical-slice and independently verifiable acceptance approach used by Matt Pocock's `to-tickets`. The QA and Tester templates adapt test-planning practices that require preconditions, steps, expected results, test data, risk, traceability and explicit pass/fail criteria.
