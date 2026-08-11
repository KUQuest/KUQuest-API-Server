# Linear template: Backend implementation

Use this as the description for a Backend team issue template in Linear.
The authoritative design and the Frontend, Mobile, QA Automation and manual
Verification variants are in [linear-issue-templates-draft.md](../../linear-issue-templates-draft.md).

## Linear defaults

- Team: `Backend`
- Status: `Backlog` or `Todo`
- Labels: `Role/Implementation`, `Type/Feature`, `Agent State/ready-for-agent`, `QA Policy/Required`
- Estimate: required before scheduling
- Project: required
- Milestone: required when it supplies the planned date
- Due date: required unless a dated milestone supplies the planned date
- Priority: required
- Parent spec/PRD and blocking relations: add when applicable

## Description template

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
- [ ] PR contains exact verification commands and a QA Brief.
- [ ] No secret or sensitive data is exposed in logs/errors.
- [ ] Issue has entered `Ready for QA`; do not mark it Done until the linked verification passes.
```

Reject the issue if authorization/ownership rules, persistence failure
semantics, or observable error behavior are unspecified, or if it describes
only a non-demonstrable schema layer without an approved expand-contract plan.
