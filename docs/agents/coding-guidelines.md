# Coding guidelines

Behavioral guidelines to reduce common LLM coding mistakes ([source](https://github.com/multica-ai/andrej-karpathy-skills)). Bias toward caution over speed; use judgment on trivial tasks.

**1. Think before coding** — don't assume, don't hide confusion, surface tradeoffs.

- State assumptions explicitly; if uncertain, ask.
- If multiple interpretations exist, present them — don't pick silently.
- If a simpler approach exists, say so; push back when warranted.
- If something is unclear, stop, name what's confusing, ask.

**2. Simplicity first** — minimum code that solves the problem, nothing speculative.

- No features beyond what was asked. No abstractions for single-use code. No unrequested "flexibility". No error handling for impossible scenarios.
- 200 lines that could be 50 → rewrite it.
- Ask: "Would a senior engineer call this overcomplicated?" If yes, simplify.

**3. Surgical changes** — touch only what you must, clean up only your own mess.

- Don't "improve" adjacent code, comments, or formatting. Don't refactor what isn't broken. Match existing style even if you'd do it differently.
- Unrelated dead code: mention it, don't delete it.
- Remove imports/variables/functions YOUR changes made unused; don't remove pre-existing dead code unless asked.
- Deleting an option or a parameter: for each caller you migrate off it, name the guarantee that caller loses, and keep the guarantee locally when it was load-bearing. A caller that compiles can still be broken — a script that used an idempotency key for re-run safety dies on the unique constraint instead of skipping.
- Deleting a validation or a guard: search the tests for its message first. A refusal with a test pinning it is deliberate, whatever the code around it suggests. `scripts/seed-finance-test.ts` rejects a production Xendit key although the seed calls no provider, and `tests/operations/finance-seed.integration.test.ts` pins that refusal with three siblings. When a guard creates friction, fix the documentation that explains it.
- Test: every changed line traces directly to the user's request.

**4. Goal-driven execution** — define success criteria, loop until verified.

- "Add validation" → write tests for invalid inputs, then make them pass.
- "Fix the bug" → write a test that reproduces it, then make it pass.
- "Refactor X" → ensure tests pass before and after.
- Multi-step tasks: state a brief plan, one line per step with its verify check.

These guidelines are working if: fewer unnecessary changes in diffs, fewer rewrites from overcomplication, clarifying questions come before implementation rather than after mistakes.
