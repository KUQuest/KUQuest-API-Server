# BE-89 audit: does `src/modules/auth/**` satisfy the BE-69 mobile auth acceptance criteria?

> Location note: this repo has no prior research-notes convention. This file establishes
> `docs/research/` as that location for BE-89. Read-only audit — no source files were changed.

Scope: BE-89 (child of wayfinder map BE-88), checking whether the backend already satisfies two
BE-69 acceptance criteria needed for FE-19/FE-20/FE-21 (Android auth + onboarding) to integrate.
Out of scope / already settled, not re-flagged here:

- The `.mount()` raw-handler bypass of the app's `{success,error:{code,message}}` envelope
  (`src/modules/auth/auth.plugin.ts:13-30`) — settled in BE-33, required by `@better-auth/expo`.
- The student auth handler's lack of a path allow-list (unlike the 3-path admin allow-list at
  `auth.plugin.ts:7-11`) — tracked separately in BE-87.

All claims below are cited to `file:line` in this repo or to the installed `better-auth`
(`^1.6.25`) / `@better-auth/core` / `@better-auth/expo` (`1.6.23`) source under `node_modules`,
since better-auth is the library actually implementing sign-up/sign-in, session expiry, refresh,
and revocation — the app config only parameterizes it.

---

## Criterion 1 — Do sign-up and sign-in contracts distinguish account creation from existing-account auth?

### What exists today

Google is the only enabled auth method (`src/modules/auth/auth.config.ts:26-45`,
`emailAndPassword.enabled: false`). Better-auth has **no separate `/sign-up/social` endpoint** —
social/OAuth auth is a single unified contract, `POST /api/auth/sign-in/social`, that creates the
account on first sign-in and reuses it on every subsequent sign-in. There is no app-code path here
that could introduce a duplicate-account bug; the dedup happens entirely inside better-auth:

- `handleOAuthUserInfo` (`node_modules/@better-auth/core` via
  `node_modules/better-auth/dist/oauth2/link-account.mjs:9-16`) looks the user up by
  `findOAuthUser(email, accountId, providerId)`. If found, it reuses/relinks the existing user
  (lines 16-70); only if **not** found does it call `createOAuthUser` (lines 71-110). It sets
  `isRegister = !user` (line 16) to record which branch ran.
- This same function backs **both** entry points mobile could use:
  - the redirect/authorization-code flow, called from
    `node_modules/better-auth/dist/api/routes/callback.mjs:145-160`;
  - the native `idToken` flow (what `@better-auth/expo`-based Google Sign-In on Android typically
    uses), called from `node_modules/better-auth/dist/api/routes/sign-in.mjs:168-184`.

So: **signing up with an existing account cannot create a duplicate** (it always resolves to the
same user row via `findOAuthUser`), and **"signing in" with a not-yet-seen `@ku.th` account
creates it** by design — because there is no separate registration step for SSO-only auth. That is
almost certainly the intended behavior for a Google-Workspace-restricted app: first sign-in *is*
sign-up. Nothing in `auth.config.ts` sets `disableImplicitSignUp` on the google provider, so this
default (auto-create-on-first-sign-in) is active.

### Is the distinction visible/documented anywhere?

Only partially, and only for one of the two flows:

- **Redirect/web flow**: `callback.mjs:170-176` redirects to `newUserURL || callbackURL` — i.e.
  `result.isRegister` picks between the `newUserCallbackURL` and `callbackURL` request params.
  This is documented: `SocialSignInRequest.newUserCallbackURL` in
  `src/modules/auth/auth.openapi.ts:202-206`. A client using this flow *can* tell new vs. existing
  by which URL it lands on.
- **Native `idToken` flow**: `sign-in.mjs:189-195` returns
  `{ redirect: false, token: session.token, url: undefined, user }` — **`isRegister` is computed
  but never included in this JSON response.** A client using the native flow (idToken from Google
  Sign-In SDK, the flow `@better-auth/expo` on Android is built around) has **no field in the
  response body** telling it whether this was a new account or a returning one.
- `src/modules/auth/auth.openapi.ts:183-235` (`SocialSignInRequest`/`SocialSignInResponse`)
  documents only the redirect-flow shape (`provider`, `callbackURL`, `disableRedirect` →
  `{url, redirect}`). **It does not mention the `idToken` request field at all, nor the
  `{redirect:false, token, user}` response shape the native flow actually returns.** OpenAPI is
  incomplete for whichever flow Android actually drives through the raw `/api/auth/sign-in/social`
  endpoint.
- No app code anywhere tracks or re-exposes `isRegister`/"new user" — confirmed by grep across
  `src/` (only hit is the unrelated `newUserCallbackURL` OpenAPI field name). The
  `onboarding` module (`src/modules/onboarding/*`) exists as a separate concern; nothing in it
  reads an auth-supplied "is new user" flag, so it's presumably driven by
  profile/onboarding-completeness state instead, not this flag.

### Verdict

- **Functional correctness (no duplicates, no accidental-signup-that-should-have-been-signin)**:
  **satisfied**, natively, by better-auth's `findOAuthUser`/`isRegister` logic. Not a gap.
- **Client-visible new-vs-existing signal in the native `idToken` JSON response**: **missing**.
  Given FE-19 covers "session routing," if routing decisions (e.g., "show onboarding" vs
  "go to dashboard") were meant to key off this signal directly from the sign-in response, they
  can't — it isn't there. **Judgment: not a blocker** as long as session routing is driven by a
  separate onboarding-status/profile-completeness check (which is the more robust design anyway,
  since it survives session refresh/relogin and doesn't require plumbing a one-shot flag through
  the client). Worth a quick confirmation with FE-19 that this is indeed how routing is decided,
  but there is no backend code change implied unless they say otherwise.
- **OpenAPI documenting the wrong/incomplete flow** (`auth.openapi.ts:183-235` only describes the
  redirect flow, not the `idToken` flow mobile is likely to use): **documentation gap, not a
  blocker** — the `@better-auth/expo` client SDK is typed directly against the `auth` instance
  (not generated from this OpenAPI doc), so Android integration doesn't depend on this doc being
  complete. Still worth fixing so the spec isn't actively misleading.

---

## Criterion 2 — `@ku.th` rejection, session shape, expiry/refresh/revocation, unauthorized error codes

### Where `@ku.th` is enforced

Two layers exist, and they do **not** trigger under the same conditions — this is the most
concrete finding of this audit:

1. **Google's own `hd` (hosted-domain) check, inside better-auth's core Google provider**
   (`node_modules/@better-auth/core/dist/social-providers/google.mjs`), driven by
   `hd: ALLOWED_EMAIL_DOMAIN` passed at `src/modules/auth/auth.config.ts:34`:
   - `verifyIdToken` (google.mjs:94-104) — used by the **native `idToken` flow** — decodes the ID
     token and calls `isGoogleHostedDomainAllowed(options.hd, jwtClaims.hd)` (google.mjs:35-40:
     requires exact string match, personal Gmail has no `hd` claim → rejected). Returning `false`
     here makes `sign-in.mjs:150-153` throw `APIError.from("UNAUTHORIZED", INVALID_TOKEN)` — a
     generic 401, **before `getUserInfo`/`mapProfileToUser` ever runs**.
   - `getUserInfo` (google.mjs:105-112) — used by the **redirect/callback flow** — repeats the
     same `hd` check and returns `null` on mismatch. `callback.mjs:88-91` then treats this as
     `unable_to_get_user_info` and redirects to the error URL with that generic code — again
     **before** `mapProfileToUser` runs (google.mjs:113 is only reached after the check on
     line 109-112 passes).
2. **App-level `assertAllowedEmail`** (`src/modules/auth/auth.policy.ts:15-22`), wired in as
   `mapProfileToUser` at `auth.config.ts:36-37`. It throws
   `APIError('FORBIDDEN', { code: 'EMAIL_DOMAIN_NOT_ALLOWED', message: ... })`, documented as the
   403 response for `/api/auth/sign-in/social` at `src/modules/auth/auth.openapi.ts:276`.

**Because both better-auth entry points (`verifyIdToken` and `getUserInfo`) already run the same
`hd`-based rejection before `mapProfileToUser`/`assertAllowedEmail` is invoked, `assertAllowedEmail`
is unreachable for the case it appears to exist for** (a non-`@ku.th` Google account attempting
sign-in). The only way it would actually fire is an edge case where Google's `hd` claim says
`ku.th` but the account's email doesn't (not something to design around). In practice:

- A personal Gmail / non-`ku.th` account hitting the **native `idToken` flow** gets **401,
  `INVALID_TOKEN`, "Invalid token"** — not the documented 403 `EMAIL_DOMAIN_NOT_ALLOWED`.
- The same account hitting the **redirect flow** gets redirected with error code
  `unable_to_get_user_info` — again not `EMAIL_DOMAIN_NOT_ALLOWED`.
- `src/modules/auth/auth.openapi.ts:276` (`403: errorResponse('The Google account is not in the
  ${ALLOWED_EMAIL_DOMAIN} domain.')`) and the `AuthError` example at `auth.openapi.ts:44`
  (`EMAIL_DOMAIN_NOT_ALLOWED`) describe a response shape a client is unlikely to ever actually see
  from `/api/auth/sign-in/social`.
- No test in `tests/modules/auth/**` exercises this end to end. `tests/modules/auth/auth.policy.test.ts:1-14`
  only unit-tests the pure `isAllowedEmail()` predicate; `tests/modules/auth/auth.integration.test.ts`
  never drives a non-`ku.th` Google login through either flow. So this mismatch between documented
  and actual behavior has no test coverage either way.

**Judgment**: domain restriction *is* enforced end-to-end — a non-`@ku.th` account cannot get a
session, on either flow. So this is **not a functional blocker**: mobile can build a working
"reject and show an error" flow. But if FE-19/20 built any client-side logic keyed to the
documented `EMAIL_DOMAIN_NOT_ALLOWED` code (e.g., a specific "please use your KU account" message
triggered by that code), that logic will never fire for the native flow — it needs to instead
handle generic `INVALID_TOKEN`/401. **Worth flagging back to FE-19 explicitly**, since this is the
kind of gap that fails silently (fallback to a generic error message) rather than loudly. Given
FE-19 already marks itself near-done, confirming which error code its client actually branches on
is cheap and worth doing before calling this closed.

### Session token shape

Cookie-based, database-backed session (not a stateless JWT). Schema:
`src/database/schema/auth.schema.ts:81-98` (`authSession`: `token`, `expiresAt`, `ipAddress`,
`userAgent`, unique constraint on `token`). Wire shape is documented at
`src/modules/auth/auth.openapi.ts:105-140` (`AuthSession`/`AuthSessionResponse`: `id`, `userId`,
`expiresAt`, `createdAt`, `updatedAt`, `ipAddress`, `userAgent`, plus `user`). `GET
/api/auth/get-session` returns `null` (200) when unauthenticated (`auth.openapi.ts:367-419`,
matching actual behavior — session.mjs:191 `return ctx.json(null)`, and confirmed by
`tests/modules/auth/auth.integration.test.ts:28-35`).

For the native `idToken` sign-in response specifically (`sign-in.mjs:190-195`): `{ redirect: false,
token: session.token, url: undefined, user }` — a **flat `token` string**, not the nested
`{session, user}` shape `get-session` returns. This is a real shape difference between the two
better-auth responses a mobile client will see (sign-in vs. get-session) that isn't documented
anywhere in `auth.openapi.ts` (which, per Criterion 1, doesn't document the `idToken` response at
all). Cookie delivery: `defaultCookieAttributes` (`auth.config.shared.ts:6-10`,
`sameSite: 'none', secure: true, httpOnly: true`) applies to both; the `expo()` plugin
(`node_modules/@better-auth/expo/dist/index.js:62-84`) also appends the `Set-Cookie` value as a
query param on the OAuth redirect URL for the redirect flow, so an Expo client can capture it
manually and replay it as a `Cookie` header on future requests (no bearer-token plugin is
registered in `auth.config.ts`, so this cookie-replay mechanism is the only session-transport path
available to mobile for the redirect flow).

### Expiry / refresh behavior

No `session.expiresIn`/`session.updateAge` override anywhere in `auth.config.ts` (only
`session: { modelName: 'authSession' }`, lines 62-64) — **library defaults apply**:
`node_modules/better-auth/dist/context/create-context.mjs:146-148`:
`expiresIn: 604800` (7 days), `updateAge: 86400` (1 day), `freshAge: 86400`.

Refresh is **implicit and rolling**, not a separate `/refresh` endpoint — it happens as a
side-effect of any `getSession` call (which `src/modules/auth/auth.guard.ts:10` calls on every
guarded request): `node_modules/better-auth/dist/api/routes/session.mjs:205-239`. If the session is
within `updateAge` (1 day) of `expiresAt`, the row's `expiresAt` is pushed out another full
`expiresIn` (7 days) and a fresh `Set-Cookie` is issued (lines 225-239). So a session that is used
at least once a week never expires; one left completely idle for >7 days does. There is no
document/test in this repo asserting this rolling-refresh window, but it's not app code to test —
it's library-default behavior, config-verifiable by inspecting `auth.options.session` (which is
currently unset/default).

### Revocation

Better-auth exposes this natively, unconfigured by app code, at (assuming no path allow-list per
BE-87) `/api/auth/revoke-session`, `/api/auth/revoke-sessions`, `/api/auth/revoke-other-sessions`
(`node_modules/better-auth/dist/api/routes/session.mjs:405-505`, all `deleteSession` against the
DB row — since sessions are DB-backed, revocation is immediate and doesn't require token
blocklisting). `/api/auth/sign-out` similarly deletes the session row and clears the cookie
(documented at `auth.openapi.ts:444-464`). None of these are called out by name in
`tests/modules/auth/**` or `auth.openapi.ts` (only `sign-out` is documented). **Documentation gap,
not a functional gap** — the endpoints work via better-auth defaults; they're just not in this
repo's OpenAPI surface or test suite.

### Unauthorized error codes

Two distinct error surfaces, consistent with the already-settled BE-33 finding (flat
`{code,message}` from the raw-mounted better-auth handler vs. the app's `{success,error}` envelope
from typed routes) — not re-litigating that shape difference, just cataloguing codes:

- **From better-auth itself** (`node_modules/@better-auth/core/dist/error/codes.mjs`,
  confirmed via `.d.mts:26-41`): `PROVIDER_NOT_FOUND`, `INVALID_TOKEN`, `ID_TOKEN_NOT_SUPPORTED`,
  `FAILED_TO_GET_USER_INFO`, `USER_EMAIL_NOT_FOUND`, `SESSION_EXPIRED`, plus ad hoc
  `{code:"UNAUTHORIZED"}` thrown by `sessionMiddleware`
  (`node_modules/better-auth/dist/api/routes/session.mjs:320-363`) guarding
  `revoke-session`/`list-sessions`/etc. for unauthenticated callers. All surface as HTTP 401 via
  `APIError.from("UNAUTHORIZED", ...)`.
- **From this app's own guarded routes** (not the raw-mounted auth handler): `authGuard`
  (`src/modules/auth/auth.guard.ts:13-14`) returns `status(401, apiError('UNAUTHORIZED',
  'Unauthorized'))` — the app's envelope shape, for any typed route (onboarding, profile, etc.)
  called without a valid session. `adminAuthenticationGuard`
  (`src/modules/auth/admin-auth.guard.ts:23-27`) does the same for admin routes, plus a 403
  `ADMIN_DISABLED` (`admin-auth.guard.ts:50-54`) for disabled admin accounts — admin-only, not
  relevant to the mobile student flow.

**Judgment**: functionally complete — every unauthorized path returns 401 with *some* code, no
request silently succeeds without a session. The gap is purely that the **specific codes a mobile
client will see for domain rejection** (`INVALID_TOKEN` for the flow it likely uses) diverge from
what's documented (`EMAIL_DOMAIN_NOT_ALLOWED`), covered above. Not a blocker; worth a doc fix and,
ideally, an integration test that actually drives a non-`ku.th` sign-in through the native flow and
pins down which code comes out, since right now that behavior is only known by reading library
source, not by anything asserted in this repo.

---

## Summary table

| Question | Exists? | Where | Gap? | Blocker for FE-19/20/21? |
|---|---|---|---|---|
| Sign-up doesn't duplicate an existing account | Yes | `link-account.mjs:9-16` (`findOAuthUser`) | No | No |
| Sign-in doesn't silently create an unwanted account | By design, auto-creates on first sign-in (no `disableImplicitSignUp` set) | `auth.config.ts:29-44` | Design choice, not a bug, given SSO-only auth | No |
| New-vs-existing signal in native `idToken` sign-in response | No | `sign-in.mjs:189-195` omits `isRegister` | Yes | No, if onboarding routing uses profile state instead — confirm with FE-19 |
| OpenAPI documents the `idToken` flow mobile likely uses | No | `auth.openapi.ts:183-235` only covers redirect flow | Yes | No (doc-only; `@better-auth/expo` client isn't OpenAPI-driven) |
| `@ku.th` domain enforced | Yes, twice (Google `hd` check pre-empts app check) | `google.mjs:94-112`, `auth.policy.ts:15-22` | `assertAllowedEmail`/`EMAIL_DOMAIN_NOT_ALLOWED` effectively unreachable; docs describe wrong code | No (rejection works), but confirm client doesn't branch on the undocumented-to-not-fire code |
| Session shape documented | Partially | `auth.openapi.ts:105-140` (get-session) vs. undocumented `sign-in.mjs:190-195` shape | Yes | No |
| Expiry/refresh behavior | Yes, library default, rolling | `create-context.mjs:146-148`, `session.mjs:205-239` | Undocumented/untested in-repo, but correct | No |
| Revocation | Yes, library default | `session.mjs:405-505` | Undocumented/untested in-repo, not exposed in OpenAPI | No |
| Unauthorized error codes | Yes, two surfaces (better-auth native vs. app envelope) | see above | Divergence between documented and actual domain-rejection code | No, but recommend confirming with FE-19 |

**Overall**: no functional blockers found for FE-19/20/21 to build a working Google sign-in +
session flow against today's `src/modules/auth/**`. The gaps found are documentation/test-coverage
gaps: (1) OpenAPI doesn't describe the native `idToken` request/response shape mobile likely uses,
(2) the documented `EMAIL_DOMAIN_NOT_ALLOWED` 403 doesn't match the actual `INVALID_TOKEN` 401 a
domain-rejected native-flow client receives, and (3) revocation/refresh behavior is real (via
better-auth defaults) but asserted nowhere in this repo's tests or docs. The one item worth an
explicit round-trip with FE-19 before closing BE-89 is confirming their client doesn't branch on
`EMAIL_DOMAIN_NOT_ALLOWED` specifically for the domain-rejection UX, since that code won't appear
on the flow they're most likely using.
