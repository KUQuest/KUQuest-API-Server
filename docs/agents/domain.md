# Domain Docs

This is a single-context repository.

## Before exploring

Read these sources when they exist:

- `CONTEXT.md` at the repository root
- Relevant architectural decisions under `docs/adr/`

For any work on Work Chat, Quest Condition or Quest Edit, Sent Work, Proof
Submission, review Popup, System Message, Android Push, or Quest Reward
settlement, also read `docs/quest/work-chat-system-target.md` before changing
the domain, schema, API, UI, notification, or money flow. It is the accepted
target contract and identifies older documents that must be reconciled.

If they do not exist, proceed silently. Domain-modeling skills create them
lazily when terminology or architectural decisions are established.

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
