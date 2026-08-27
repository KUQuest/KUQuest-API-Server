# KUQuest API Server

Backend serving the KUQuest Mobile app and Admin web app: authentication, onboarding, and (eventually) quest/gamification data for Kasetsart University Members.

## Language

**Member**:
The end user of KUQuest — anyone authenticated with a Google account under the `@ku.th` email domain. Represented by the `auth_user` table.
_Avoid_: User, account holder, Student (use Member when the KUQuest identity matters, User only when referring generically to the auth record).

**Admin**:
A KUQuest Admin web app operator, signed in with credentials (not Google). Represented by the `auth_admin` table — a separate identity space from Member, sharing `auth_account`/`auth_session` via a nullable `userId`/`adminId` pair (exactly one set per row). Schema landed in [[BE-32]]; the second better-auth instance wiring credential login for Admins is a follow-up, not yet built.
_Avoid_: User (Admins are never Members and vice versa).

**Onboarding**:
The one-time step after first sign-in where a Member supplies Telephone, Department, and Student ID. A Member is considered onboarded once all three fields are set. The routes under `/api/v1/onboarding/*` are debug scaffolding, not a contract — do not build against them, and do not treat their validation rules as canonical. Superseded by Academic Registration below, which is the canonical contract mobile integrates against ([[BE-95]]).
_Avoid_: Profile setup, registration.

**Academic Registration**:
The canonical, resumable first-run step where a Member supplies name, Telephone, Occupation, Student ID (conditional — required unless the chosen Occupation's `requiresStudentId` is false), Department, and Terms acceptance, served by `/api/v1/academic-registration/*` ([[BE-95]]). Draft-save is coarse-grained: fields are nullable columns directly on `auth_user`, replaced but never cleared (same convention as Profile), no step-pointer or state machine. `GET /status` returns the current field values for the mobile app to pre-fill its form, plus a `completed` boolean computed from field truthiness (Student ID only required in that computation when the stored Occupation's `requiresStudentId` is true). `GET /options` lists Occupations and the Faculty/Department hierarchy by canonical ID. Avatar capture during this step reuses `POST /api/v1/profile/avatar` unchanged — no separate draft-upload path, since the `auth_user` row already exists by Google sign-in.
_Avoid_: Onboarding (superseded term for the canonical contract; still used only for the legacy debug-scaffolding routes above).

**Profile**:
The scalar fields a Member holds on `auth_user` — name, bio, Telephone, Student ID, academic year, Department — served by `/api/v1/profile`. A Member may edit only their own, and only the subset the endpoint owns (first name, last name, bio, Telephone, Department); the rest is read-only there. Values can be replaced but never cleared, so nobody un-onboards themselves through the edit screen. The current avatar is read here as a file reference plus a link that expires, built per request — no storage URL is ever persisted — while uploading and replacing it belongs to `POST /api/v1/profile/avatar` ([[BE-41]]). A tombstoned `file` row reads as no avatar. Portfolio items (`profile_portfolio_item`, [[BE-39]]) and certificates (`profile_certificate`, [[BE-40]]) are separate resources, each owned by its own endpoint under `/api/v1/profile/*`, and are deliberately absent from the Profile response. Work Experience (`profile_work_experience`) is managed through the authenticated `/api/v1/profile/experience` collection and is embedded in Public Profile reads.
_Avoid_: Account (that is the auth record), treating Profile as the whole of a Member's data.

**Work Experience**:
A public entry in a Member's profile describing one role or activity through its title, employment type, optional organization and description, and start/end dates. A null end date means the role is ongoing; a Member may have multiple entries.
_Avoid_: Experience history, treating Work Experience as a single profile field.

**Public Profile**:
The read-only view of another Member's Profile, served by `GET /api/v1/profile/:userId` — same underlying data as own-Profile, narrower field set (no Telephone/Student ID), requires an authenticated Member caller but not ownership (settled via /grilling, 2026-08-09). Unlike own-Profile, Portfolio items and Certificates ARE inlined into the Public Profile response (a deliberate exception to Profile's "separate resource" rule, made so a viewer doesn't need per-userId variants of every sub-resource endpoint). Reputation is derived from eligible Quest relationships, while Profile Tags are derived from successfully completed Quest participation; neither has a shipped runtime module yet (BE-76/79-83 still Backlog). No opt-out: every Member is browsable, no privacy toggle exists.
_Avoid_: conflating with own-Profile's response shape — they share a resource but not a schema.

**Tag**:
A shared Quest skill label used to describe the ability demonstrated by a Quest. Each Quest has exactly one canonical Tag. A Member's profile Tags are derived from their three most frequent Tags across successfully completed Quest participation; they are not manually assigned profile data.
_Avoid_: profile skill, occupation, treating Tags as editable Member fields.

**Review**:
A rating and optional comment that a Hirer or Worker gives to the other after a Quest is completed. A Review is tied to one Quest, each direction is allowed once per Quest, and the author may edit it until seven days after Quest completion. Reviews cannot be deleted and contribute to the reviewed Member's Reputation.
_Avoid_: reviewing before Quest completion; treating a Review as a Profile field that can be edited by someone else.

**Giver**:
The Student who creates a Quest and funds its rewards.
_Avoid_: Employer, client, job owner.

**Hunter**:
A Student who performs a Quest in exchange for its reward.
_Avoid_: Worker, employee, contractor.

**Quest Reward**:
The amount earned by each Hunter who successfully completes a Quest; for a group Quest, the same reward applies independently to every Hunter slot. The displayed Quest Reward is the Hunter's full earnings and excludes the Platform Fee paid by the Giver.
_Avoid_: Wage, salary, shared prize pool.

**Platform Fee**:
An amount paid by the Giver in addition to the Quest Rewards when Hunters successfully complete a Quest.
_Avoid_: deducting the Platform Fee from a Hunter's displayed Quest Reward.

**Wallet**:
A Student's KUQuest funds, separated by whether they can be spent, paid out, or are temporarily committed to a Quest or Payout.
_Avoid_: Bank account, Account (auth), treating the Wallet as one undifferentiated balance.

**Wallet Status**:
The Wallet's permission state: Active permits Student-initiated operations, Frozen is a temporary administrative hold, Suspended is a policy hold requiring review, and Closed is terminal. Non-active Wallets still receive or release money required to reconcile commitments already in progress.
_Avoid_: treating a hold as permission to discard confirmed inbound money or existing obligations.

**Spending Balance**:
Wallet funds a Student can commit to Quest rewards. A Top-up increases this balance.
_Avoid_: Credit, available earnings.

**Earnings Balance**:
Wallet funds a Student earned by completing Quests and can either convert to Spending Balance or withdraw through a Payout.
_Avoid_: Spending Balance, income account.

**Earnings Conversion**:
An immediate, fee-free, and irreversible transfer from a Student's Earnings Balance to their Spending Balance.
_Avoid_: Payout, reversible exchange.

**Quest Escrow**:
Spending Balance committed by a Giver to cover Quest Rewards and Platform Fees until the future Quest workflow settles or releases it. The Quest domain owns the timing and lifecycle; the Wallet only owns the reserved funds.
_Avoid_: Job hold, locked balance, inferring escrow from Wallet activity.

**Funding Reservation**:
Spending Balance set aside for a caller-owned workflow until that workflow releases it or settles it into a recipient's Earnings Balance and optional Platform Fee revenue.
_Avoid_: assuming every Funding Reservation is Quest Escrow or embedding the caller's lifecycle in the Wallet.

**Payout Reserve**:
Earnings Balance committed to an in-progress Payout and unavailable for another Payout or conversion until that Payout settles or fails.
_Avoid_: Quest Escrow, withdrawn balance.

**Top-up**:
An inbound payment that adds its quoted amount to a Student's Spending Balance after the payment provider confirms it. The Student pays the provider fee and tax in addition to the amount credited.
_Avoid_: Deposit, earnings, Wallet credit (too broad).

**Payout**:
An outbound transfer of a Student's Earnings Balance to their chosen payout destination. The transfer amount, provider fee, and tax are all debited from Earnings Balance.
_Avoid_: Withdrawal request (the Payout includes the full transfer lifecycle), Quest Reward.

**Payout Destination**:
The Student's own Thai bank or PromptPay destination to which a Payout is sent. A Student has at most one active destination; replacing or removing it retires the old destination without erasing its historical association with prior Payouts.
_Avoid_: Wallet, bank account stored as disposable profile data.

**Money Policy**:
A versioned set of financial amount limits and rates used to quote and commit money operations. Quest timing and dispute-approval rules belong to their own domains rather than Money Policy.
_Avoid_: treating all configurable product rules as financial policy.

**Certificate**:
A credential a Member claims — `name`, `issuer`, and the date it was issued, plus an optional image of the credential. Stored one row per credential in `profile_certificate`, owned by the Member who created it, and served by `/api/v1/profile/certificates` ([[BE-40]]). Deliberately not part of the Profile response (see Public Profile above for the one exception): a Member may hold any number of them, and each is created, edited, and deleted on its own. Ownership is scoped in the query rather than checked after reading, so another Member's Certificate is indistinguishable from one that does not exist — both are `404 CERTIFICATE_NOT_FOUND`. The image is a file reference plus an expiring link, same pattern as the avatar — no storage URL is ever persisted — uploaded via its own sub-route after the certificate row exists. Formerly carried a `verifyUrl` link instead of an image (settled via /grilling, 2026-08-09: replaced, not additive — existing `verifyUrl` values are dropped on migration, no backfill path from a URL to an image).
_Avoid_: Qualification, badge (a badge is gamification, not a Certificate); treating a Certificate as a Profile field; verifyUrl/verification link (superseded term).

**Student ID**:
A KU-issued 10-digit identifier a Member provides during Onboarding. Distinct from the internal `auth_user.id` (a generated auth identifier) — Student ID is KU's own number, stored in `auth_user.studentId`.
_Avoid_: User ID, student number.

**Department** / **Faculty**:
A Member's academic department (`department` table) belongs to a Faculty (`faculty` table, e.g. Engineering). Captured during Onboarding as `auth_user.departmentId`, a foreign key — no more free-text faculty field. Formerly called Major; the `major` table and `auth_user.majorId` column were renamed to `department`/`departmentId` (no third hierarchy level was introduced — Academic Registration's own field list never asked for a Major on top of Faculty/Department).
_Avoid_: storing faculty/department as free text; the term Major (superseded by Department).

**Occupation**:
What a Member is at KU — exactly Staff, Lecturer, or Student — captured during Academic Registration as `auth_user.occupationId`, a foreign key into the `occupation` table. Each Occupation row carries a `requiresStudentId` flag: only the Student occupation requires a Student ID; the server reads this property rather than hardcoding a name comparison.
_Avoid_: hardcoding Occupation name checks instead of reading `requiresStudentId`.

**Allowed Email Domain**:
The `@ku.th` restriction enforced at sign-in — only Google accounts under this domain may authenticate. Applies to Members only (Admins use credential login). Encoded in `auth.constants.ts` (`ALLOWED_EMAIL_DOMAIN`) and enforced by `assertAllowedEmail`/`isAllowedEmail` in `auth.policy.ts`.
_Avoid_: Email whitelist, domain check.

**Session**:
A better-auth session record (`auth_session` table) representing one authenticated Member or Admin login, tied to `auth_user` or `auth_admin` via `userId`/`adminId`. Distinct from Account, which holds the underlying OAuth/credential secrets.
_Avoid_: Token (Token refers to the raw session/access token value, not the Session record).

**Account** (auth):
The `auth_account` table row linking a Member's or Admin's identity to their OAuth (Google) or credential auth method (access/refresh/id tokens, provider id, password hash). Not to be confused with a Member's KUQuest identity itself.

**Better Auth**:
The auth library (`better-auth`) providing session management, Google OAuth, and the `/api/auth/*` HTTP surface, configured in `auth.config.ts`. Its core `name`/`image` user fields are remapped: `name` aliases `firstName` (no separate `name` column exists), `image` is an unused legacy-compat column — real avatars are `auth_user.imageFileId` → `file`.

## Quest and Work Chat

**Hirer**:
The Member who creates a Quest, commissions its work, and remains its current owner for MVP.
_Avoid_: Giver, client

**Worker**:
A Member accepted to perform work on a Quest.
_Avoid_: Hunter, candidate, assignee

**Candidate**:
A Member or team that has applied to a Candidate Quest but has not been accepted as a Worker.
_Avoid_: Chat member, assigned Worker

**Accepted Participant**:
The current Hirer or an Active Worker. Only Accepted Participants have current Work Conversation membership.
_Avoid_: Candidate, departed Worker

**Quest**:
One bounded agreement for work, owned by one Hirer and progressing through its lifecycle.
_Avoid_: Job, task

**Assignment**:
The accepted participation of one Worker in a Quest. It is the canonical record that a Worker is working on that Quest.
_Avoid_: Application, team membership

**Active Worker**:
A Worker whose Assignment has not ended.
_Avoid_: Candidate, former Worker

**Departed Worker**:
A former Active Worker whose Assignment ended before the Quest completed.
_Avoid_: Active Worker, Candidate

**Work Membership Window**:
The inclusive period in which an accepted participant has access to the Work Conversation. A former Worker retains only the history from their own window.
_Avoid_: Chat permission, participant status

**Quest Edit**:
A change to a Quest's details proposed by its Hirer.
_Avoid_: Assignment change, membership transition

**Work Conversation**:
The one working Chat conversation associated with a Quest. Its participants are the Hirer and the Active Workers, never Candidates.
_Avoid_: Group chat, team chat

**Terminal Quest**:
A Quest in `COMPLETED` or `CANCELLED`. Its Work Conversation is read-only.
_Avoid_: Closed conversation

**Work Membership Transition**:
A change to accepted Quest participation or terminal lifecycle state that changes Work Conversation membership or write access.
_Avoid_: Chat event, message event

## Consumers

- **KUQuest Mobile** — Expo app, uses native Google Sign-In (not a webview redirect) to reach this API.
- **KUQuest Admin** — Next.js admin/CMS web frontend.

## Response shape

Every endpoint returns the shared envelope defined in `src/shared/api-response.ts` / `api-response.schema.ts`: `{ success: true, data? }` or `{ success: false, error: { code, message } }`. See `ApiResponse`, `ApiSuccess`, `ApiError`.
