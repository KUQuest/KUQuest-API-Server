# Domain Docs

This is a single-context repository.

## Before exploring

Read these sources when they exist:

- `CONTEXT.md` at the repository root
- Relevant architectural decisions under `docs/adr/`

For a Candidate Inquiry Conversation or a pre-assignment question, read the
`Candidate Inquiry Conversation contract` in
`docs/rulebook/quest/quest-work-chat-rulebook.md` before changing the domain, schema,
API, UI, or notification flow. For a Work Conversation, Quest Condition or
Quest Edit, Sent Work, Proof Submission, review Popup, System Message, Android
Push, or Quest Reward settlement, read the corresponding target sections in
that same file. It is the accepted target contract.

If they do not exist, proceed silently. Domain-modeling skills create them
lazily when terminology or architectural decisions are established.

## Rulebooks

A Rulebook is accepted domain policy. It defines what the Server must do for
one domain. `CONTEXT.md` defines the canonical language; it is not a Rulebook.

### Accepted Rulebooks

- `docs/rulebook/quest/quest-work-chat-rulebook.md` — Quest and Work Chat.
- `docs/rulebook/admin/admin-rulebook.md` — Admin Operations.
- `docs/rulebook/finance/finance-rulebook.md` — Finance and Wallets.

### Authority

1. A relevant Rulebook defines current policy for its Domain and overrides
   Legacy Implementation.
2. Each Rulebook owns its Domain. A shared flow must name its exact boundary;
   neither Rulebook is globally superior.
3. ADRs record decisions. Reconciliation documents describe the difference
   between a Rulebook and Legacy Implementation. Neither document type defines
   domain policy.

### Reading route

For a complete decision table mapping tasks, branches, actors, and Quest states directly to Rulebooks, sub-contracts, ADRs, and reconciliation guides, see [`docs/agents/routing.md`](routing.md).

- **Policy** — read the Rulebook that owns the Domain before planning.
- **Known conflict** or **Legacy Implementation** — read the owning Rulebook,
  then the current-state evidence: `docs/reconciliation/quest-reconciliation.md` for Quest
  and Work Chat, or `docs/reconciliation/admin-reconciliation.md` for Admin.
  A Known conflict is a Rulebook requirement that Legacy Implementation does
  not meet. The Rulebook defines the required result.
- **Deprecated source** — read `docs/deprecated/` only as historical evidence.
  It does not define current policy.

### Declarations

An accepted Rulebook starts with these plain metadata lines:

```text
Type: Rulebook
Status: accepted
Domain: <domain>
Authority: <policy boundary>
Approved by: Domain Owner
Approved at: YYYY-MM-DD
```

A proposed policy document starts with:

```text
Type: Candidate Rulebook
Status: awaiting Domain Owner approval
Domain: <domain>
Proposed Authority: <policy boundary>
```

### Candidate and revision process

Create Candidate Rulebooks in `docs/spec/`. They do not define current
policy. An accepted Rulebook remains effective while a Candidate Rulebook is
reviewed. The Domain Owner must explicitly approve every policy change to a
State transition, actor permission, Admin action, or money movement. After
approval, replace the accepted Rulebook with the Candidate Rulebook and remove
the Candidate file. Spelling and formatting corrections do not require a
Candidate Rulebook.

## Expected layout

```text
/
├── CONTEXT.md
├── docs/
│   └── adr/
└── src/
```

## Vocabulary

Use domain terms as defined in `CONTEXT.md`. Do not substitute terminology that
the glossary explicitly avoids.

If a needed concept is missing, reconsider whether the new term is necessary or
record the gap for domain modeling.

## Architectural decisions

If proposed work contradicts an existing ADR, identify that conflict explicitly
instead of silently overriding the decision.
