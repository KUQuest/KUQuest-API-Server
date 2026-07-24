# KUQuest API Server

Backend serving the KUQuest Mobile app and Admin web app: authentication, onboarding, and (eventually) quest/gamification data for Kasetsart University students.

## Language

**Student**:
The end user of KUQuest — a KU account holder signed in via Google OAuth. Represented by the `user` table.
_Avoid_: User, account holder (use Student when the KU-specific identity matters, User when referring generically to the auth record).

**Onboarding**:
The one-time step after first sign-in where a Student supplies Telephone, Faculty, and Student ID. A Student is considered onboarded once all three fields are set.
_Avoid_: Profile setup, registration.

**Student ID**:
A KU-issued 10-digit identifier a Student provides during Onboarding. Distinct from the internal `user.id` (a generated auth identifier) — Student ID is KU's own number, stored in `user.studentId`.
_Avoid_: User ID, student number.

**Faculty**:
The academic faculty a Student belongs to at KU (e.g. Engineering), captured during Onboarding as free text in `user.faculty`.

**Allowed Email Domain**:
The `@ku.th` restriction enforced at sign-in — only Google accounts under this domain may authenticate. Encoded in `auth.constants.ts` (`ALLOWED_EMAIL_DOMAIN`) and enforced by `assertAllowedEmail`/`isAllowedEmail` in `auth.policy.ts`.
_Avoid_: Email whitelist, domain check.

**Session**:
A better-auth session record (`session` table) representing one authenticated Student's login, tied to a `user` via `userId`. Distinct from Account, which holds the underlying Google OAuth tokens.
_Avoid_: Token (Token refers to the raw session/access token value, not the Session record).

**Account** (auth):
The `account` table row linking a Student's `user` record to their Google OAuth identity (access/refresh/id tokens, provider id). Not to be confused with a Student's KUQuest identity itself.

**Better Auth**:
The auth library (`better-auth`) providing session management, Google OAuth, and the `/api/auth/*` HTTP surface, configured in `auth.config.ts`.

## Consumers

- **KUQuest Mobile** — Expo app, uses native Google Sign-In (not a webview redirect) to reach this API.
- **KUQuest Admin** — Next.js admin/CMS web frontend.

## Response shape

Every endpoint returns the shared envelope defined in `src/shared/api-response.ts` / `api-response.schema.ts`: `{ success: true, data? }` or `{ success: false, error: { code, message } }`. See `ApiResponse`, `ApiSuccess`, `ApiError`.
