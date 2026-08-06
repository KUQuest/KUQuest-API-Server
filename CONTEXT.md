# KUQuest API Server

Backend serving the KUQuest Mobile app and Admin web app: authentication, onboarding, and (eventually) quest/gamification data for Kasetsart University students.

## Language

**Student**:
The end user of KUQuest — a KU account holder signed in via Google OAuth. Represented by the `auth_user` table.
_Avoid_: User, account holder (use Student when the KU-specific identity matters, User when referring generically to the auth record).

**Admin**:
A KUQuest Admin web app operator, signed in with credentials (not Google). Represented by the `auth_admin` table — a separate identity space from Student, sharing `auth_account`/`auth_session` via a nullable `userId`/`adminId` pair (exactly one set per row). Schema landed in [[BE-32]]; the second better-auth instance wiring credential login for Admins is a follow-up, not yet built.
_Avoid_: User (Admins are never Students and vice versa).

**Onboarding**:
The one-time step after first sign-in where a Student supplies Telephone, Department, and Student ID. A Student is considered onboarded once all three fields are set. The routes under `/api/v1/onboarding/*` are debug scaffolding, not a contract — do not build against them, and do not treat their validation rules as canonical. Superseded by Academic Registration below, which is the canonical contract mobile integrates against ([[BE-95]]).
_Avoid_: Profile setup, registration.

**Academic Registration**:
The canonical, resumable first-run step where a Student supplies name, Telephone, Occupation, Student ID (conditional — required unless the chosen Occupation's `requiresStudentId` is false), Department, and Terms acceptance, served by `/api/v1/academic-registration/*` ([[BE-95]]). Draft-save is coarse-grained: fields are nullable columns directly on `auth_user`, replaced but never cleared (same convention as Profile), no step-pointer or state machine. `GET /status` returns the current field values for the mobile app to pre-fill its form, plus a `completed` boolean computed from field truthiness (Student ID only required in that computation when the stored Occupation's `requiresStudentId` is true). `GET /options` lists Occupations and the Faculty/Department hierarchy by canonical ID. Avatar capture during this step reuses `POST /api/v1/profile/avatar` unchanged — no separate draft-upload path, since the `auth_user` row already exists by Google sign-in.
_Avoid_: Onboarding (superseded term for the canonical contract; still used only for the legacy debug-scaffolding routes above).

**Profile**:
The scalar fields a Student holds on `auth_user` — name, bio, Telephone, Student ID, academic year, Department — served by `/api/v1/profile`. A Student may edit only their own, and only the subset the endpoint owns (first name, last name, bio, Telephone, Department); the rest is read-only there. Values can be replaced but never cleared, so nobody un-onboards themselves through the edit screen. The current avatar is read here as a file reference plus a link that expires, built per request — no storage URL is ever persisted — while uploading and replacing it belongs to `POST /api/v1/profile/avatar` ([[BE-41]]). A tombstoned `file` row reads as no avatar. Portfolio items (`profile_portfolio_item`, [[BE-39]]) and certificates (`profile_certificate`, [[BE-40]]) are separate resources, each owned by its own endpoint under `/api/v1/profile/*`, and are deliberately absent from the Profile response. Work experience (`profile_work_experience`) has a table but no owning endpoint yet.
_Avoid_: Account (that is the auth record), treating Profile as the whole of a Student's data.

**Certificate**:
A credential a Student claims — `name`, `issuer`, and the date it was issued, plus an optional link someone can verify it through. Stored one row per credential in `profile_certificate`, owned by the Student who created it, and served by `/api/v1/profile/certificates` ([[BE-40]]). Deliberately not part of the Profile response: a Student may hold any number of them, and each is created, edited, and deleted on its own. Ownership is scoped in the query rather than checked after reading, so another Student's Certificate is indistinguishable from one that does not exist — both are `404 CERTIFICATE_NOT_FOUND`. Certificates carry no file today; if they gain one it is a file reference like the avatar, never a stored URL.
_Avoid_: Qualification, badge (a badge is gamification, not a Certificate); treating a Certificate as a Profile field.

**Student ID**:
A KU-issued 10-digit identifier a Student provides during Onboarding. Distinct from the internal `auth_user.id` (a generated auth identifier) — Student ID is KU's own number, stored in `auth_user.studentId`.
_Avoid_: User ID, student number.

**Department** / **Faculty**:
A Student's academic department (`department` table) belongs to a Faculty (`faculty` table, e.g. Engineering). Captured during Onboarding as `auth_user.departmentId`, a foreign key — no more free-text faculty field. Formerly called Major; the `major` table and `auth_user.majorId` column were renamed to `department`/`departmentId` (no third hierarchy level was introduced — Academic Registration's own field list never asked for a Major on top of Faculty/Department).
_Avoid_: storing faculty/department as free text; the term Major (superseded by Department).

**Occupation**:
What a Student is at KU — e.g. Student or Teacher — captured during Academic Registration as `auth_user.occupationId`, a foreign key into the `occupation` table. Each Occupation row carries a `requiresStudentId` flag the server reads to decide whether Student ID is required for that Occupation, rather than hardcoding a name comparison.
_Avoid_: hardcoding Occupation name checks instead of reading `requiresStudentId`.

**Allowed Email Domain**:
The `@ku.th` restriction enforced at sign-in — only Google accounts under this domain may authenticate. Applies to Students only (Admins use credential login). Encoded in `auth.constants.ts` (`ALLOWED_EMAIL_DOMAIN`) and enforced by `assertAllowedEmail`/`isAllowedEmail` in `auth.policy.ts`.
_Avoid_: Email whitelist, domain check.

**Session**:
A better-auth session record (`auth_session` table) representing one authenticated Student or Admin login, tied to `auth_user` or `auth_admin` via `userId`/`adminId`. Distinct from Account, which holds the underlying OAuth/credential secrets.
_Avoid_: Token (Token refers to the raw session/access token value, not the Session record).

**Account** (auth):
The `auth_account` table row linking a Student's or Admin's identity to their OAuth (Google) or credential auth method (access/refresh/id tokens, provider id, password hash). Not to be confused with a Student's KUQuest identity itself.

**Better Auth**:
The auth library (`better-auth`) providing session management, Google OAuth, and the `/api/auth/*` HTTP surface, configured in `auth.config.ts`. Its core `name`/`image` user fields are remapped: `name` aliases `firstName` (no separate `name` column exists), `image` is an unused legacy-compat column — real avatars are `auth_user.imageFileId` → `file`.

## Consumers

- **KUQuest Mobile** — Expo app, uses native Google Sign-In (not a webview redirect) to reach this API.
- **KUQuest Admin** — Next.js admin/CMS web frontend.

## Response shape

Every endpoint returns the shared envelope defined in `src/shared/api-response.ts` / `api-response.schema.ts`: `{ success: true, data? }` or `{ success: false, error: { code, message } }`. See `ApiResponse`, `ApiSuccess`, `ApiError`.
