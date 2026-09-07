---
name: implement
description: "Implement a piece of work based on a spec or set of tickets."
disable-model-invocation: true
---

Implement the work described by the user in the spec or tickets.

Use /tdd where possible, at pre-agreed seams.

Run typechecking regularly, single test files regularly, and the full test suite once at the end.

Once done, use /code-review to review the work against the originating spec or tickets, repository standards, and every applicable accepted Rulebook. Use `docs/agents/routing.md` to select the Rulebook sources. Resolve each finding or record why it remains before committing.

Commit your work to the current branch.
