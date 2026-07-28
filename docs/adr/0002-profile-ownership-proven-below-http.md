# Profile ownership is proven below HTTP, not through it

`CODESTYLES.md` names integration-first the convention: hit the real `app` via `app.handle(new Request(...))` and assert on the response. The Profile tests break that pattern for one specific guarantee — that a Student can never read or write another Student's Profile — and exercise `profile.service.ts` directly against PostgreSQL instead.

No test in this repository can authenticate. A Session is created by Better Auth from a Google OAuth exchange, which a test cannot drive, and nothing exists to establish one another way. Behind `authGuard` every request without a Session stops at 401, so the HTTP seam can reach the unauthenticated rejections and — because Elysia validates the body before `onBeforeHandle` runs — every rejected-input case as well. It cannot reach a successful read, a successful update, or the ownership scoping that makes those safe. Ownership is the single guarantee the whole feature rests on, and leaving it to a human tester means a wrong `where` clause ships green.

So the tests use three seams, each carrying what only it can reach. `profile.integration.test.ts` covers everything reachable over HTTP. `profile.controller.test.ts` — the seam the avatar upload introduced, where the session and the service are both supplied by the test — carries the decisions a handler makes: which error a failed write becomes, and how a stored file reference becomes a link. `profile.service.test.ts` seeds two Students in a real database and asserts that one Student's read returns only their own row and that one Student's update leaves every field of the other's untouched.

Ownership specifically sits at the database seam rather than the controller one because a mocked service cannot show that a `where` clause selected the right row — only a real database with two Students in it can.

The cost is that `bun test` now requires a running, migrated database, which it did not before. CI runs the suite against a `kuquest_test` database of its own so the database the production image migrates stays pristine.

Delete this seam when [BE-50](https://linear.app/kuquest/issue/BE-50/authenticate-as-a-student-inside-automated-tests) lands a fixture that can establish a Session without Google. At that point the ownership assertions belong over HTTP with the rest, and `profile.service.test.ts` should be folded into the integration test rather than kept alongside it. Until then, do not "fix" these tests by moving them up — they will silently stop testing anything.

Status: accepted.
