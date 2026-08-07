# Request bodies are validated before authentication

Elysia validates a route's declared `body` during its validation phase, which runs before `onBeforeHandle` — and `onBeforeHandle` is where `authGuard` rejects a request without a Session (see [ADR 0001](0001-shared-auth-guard-plugin.md)). An anonymous caller sending a malformed body therefore receives `400 VALIDATION` describing what was wrong with it, not `401 UNAUTHORIZED`.

This is worth stating because it looks like a bug from either direction. Someone reading the guard expects it to run first. Someone reading the tests sees every rejected-input case asserted without a Session and may conclude the endpoint is unguarded.

We keep the order Elysia gives us. Reversing it would mean moving the profile body rules behind the guard, which costs the one thing that makes them testable at all: no test in this repository can hold a Session, so validation asserted through HTTP is only reachable while it runs ahead of the guard. Against that, what leaks is the shape of a public API — field names, lengths, the telephone pattern — all of which the published OpenAPI document already states openly. No profile data, and no fact about whether an account exists, is reachable this way: every path that touches a Student's row is behind the guard.

The trade would change if a body rule ever encoded something private — an allow-list of identifiers, a limit that reveals a plan tier. Such a rule does not belong in a schema validated ahead of authentication; put it in the handler, behind the guard.

Status: accepted.
