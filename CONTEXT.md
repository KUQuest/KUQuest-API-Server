# KUQuest API Server

Backend serving the KUQuest Mobile app and Admin web app: authentication, onboarding, and (eventually) quest/gamification data for Kasetsart University Members.

## Language

**Rulebook**:
An accepted domain-policy document that defines what the Server must do for one domain, including state transitions, actor decisions, Admin control, and money movement. Only a domain-policy document is a Rulebook; ADRs record decisions, and reconciliation documents describe Legacy Implementation.
_Avoid_: implementation guide, draft, historical document

**Legacy Implementation**:
Existing code, schema, or API behavior that does not implement an accepted Rulebook. It is evidence of the current server only; it does not define KUQuest policy.
_Avoid_: Rulebook, accepted target, product policy

**Domain Owner**:
The named person who approves a Candidate Rulebook for one domain. A Rulebook becomes accepted only after that explicit approval.
_Avoid_: code owner, automatic approver

**Candidate Rulebook**:
A proposed domain-policy document that awaits Domain Owner approval. It does not define current KUQuest policy.
_Avoid_: Rulebook, draft Rulebook, accepted contract

**Member**:
The end user of KUQuest — anyone authenticated with a Google account under the `@ku.th` email domain. Represented by the `auth_user` table.
_Avoid_: User, account holder, Student (use Member when the KUQuest identity matters, User only when referring generically to the auth record).

**Admin**:
A KUQuest Admin web app operator, signed in with credentials (not Google). Represented by the `auth_admin` table — a separate identity space from Member, sharing `auth_account`/`auth_session` via a nullable `userId`/`adminId` pair (exactly one set per row). Schema landed in [[BE-32]]; the second better-auth instance wiring credential login for Admins is a follow-up, not yet built. One undifferentiated permission tier — `auth_admin` has no role/permission column. For Payout Approval, Dispute Case, Quest Hide, Wallet Freeze/Suspend, Trust & Safety moderation, and the Member penalty ladders, read `docs/rulebook/admin/admin-rulebook.md`.
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
A rating and optional comment that a Hirer or Worker gives to the other after a Quest reaches any Terminal State: `QUEST_COMPLETED`, `QUEST_FAILED`, or `QUEST_CANCELLED`. A Review is tied to one Quest, each direction is allowed once per Quest, and the author may edit it until seven days after the Quest becomes Terminal. Reviews cannot be deleted and contribute to the reviewed Member's Reputation.
_Avoid_: reviewing before a Quest becomes Terminal; treating a Review as a Profile field that can be edited by someone else.

**Red Flag**:
A temporary mark on a Member's Profile after an Admin confirms that Member's first violation, blocking that Member from applying as a Candidate, joining a `FIRST_COME_FIRST_SERVED` Quest, or publishing a new Quest while it lasts. It restricts both the Worker side and the Hirer side. Expires automatically; does not require Admin action to clear. Rules are defined in `docs/rulebook/admin/admin-rulebook.md`.
_Avoid_: Ban, Suspension, treating Red Flag as a Wallet Status.

**Member Ban**:
A Member's account being made temporarily or permanently unable to sign in, reached by escalating a Misconduct ladder, which counts both hidden Messages and upheld Conduct Reports, or a low-average-review ladder. A ban also freezes the Member's Wallet. Rules, exemptions, and both ladders are defined in `docs/rulebook/admin/admin-rulebook.md`.
_Avoid_: Wallet Freeze/Suspend alone (a Wallet hold does not by itself block sign-in), Admin disabling another Admin (a separate, out-of-scope capability).

**Proof Review Window**:
The 24-hour period after a required submitter sends Proof Submission during
which the Hirer may decide the outcome. If the Hirer does not decide, the
Server records `PROOF_APPROVED`.
_Avoid_: mode-specific review deadlines.

**Giver**:
Legacy term for Hirer. In new Quest and Work Chat text, use Hirer.
_Avoid_: Giver in new domain text, Employer, client, job owner.

**Hunter**:
Legacy term for Worker. In new Quest and Work Chat text, use Worker.
_Avoid_: Hunter in new domain text, employee, contractor.

**Quest Reward**:
The portion of a Quest Funding Total paid from the Hirer's Quest Escrow to a Worker who successfully completes an Assignment. Settlement, visibility, failure, retry, and notification rules are defined in `docs/rulebook/quest/quest-work-chat-rulebook.md`.
_Avoid_: Wage, salary, shared prize pool.

**Quest Funding Total**:
The amount a Hirer commits for one Worker slot, including that slot's Quest Reward and Platform Fee. The Quest Escrow covers this total for each published headcount slot.
_Avoid_: treating the total as the Worker's Quest Reward, adding Platform Fee after the total.

**Platform Fee**:
The portion of a Quest Funding Total retained as Platform Fee when a Quest successfully completes. It is calculated from the net Quest Reward by the active Money Policy and is included in the total rather than added after it. The target failure and cancellation rules are defined in `docs/rulebook/quest/quest-work-chat-rulebook.md`.
_Avoid_: deducting the Platform Fee from a Worker's displayed Quest Reward.

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
Spending Balance committed by a Hirer to cover Quest Funding Totals until the Quest workflow settles or releases it. The Quest domain owns the timing and lifecycle; the target settlement rules are defined in `docs/rulebook/quest/quest-work-chat-rulebook.md`.
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
An outbound transfer of a Student's Earnings Balance to their chosen Payout Destination. The transfer amount, provider fee, and tax are all reserved from Earnings Balance first. The provider call starts only after an Admin approves the Payout. An Admin rejection releases the full Payout Reserve back to the Student's Earnings Balance.
_Avoid_: Withdrawal request (the Payout includes the full transfer lifecycle), Quest Reward.

**Payout Approval**:
The manual Admin decision that permits or rejects one Student Payout before the provider call. The Payout remains waiting for Admin action until an Admin approves or rejects it; there is no automatic rejection after a time limit.
_Avoid_: provider approval, automatic timeout, releasing funds without an Admin decision.

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

The entries below define the vocabulary. For Quest lifecycle, selection, Start
Work, Proof Submission, cancellation, failure, Work Chat, and reward behavior,
read `docs/rulebook/quest/quest-work-chat-rulebook.md` §Resolved Quest lifecycle first.
`docs/deprecated/` is historical evidence, not workflow authority.

**Hirer**:
The Member who creates a Quest, commissions its work, and remains its current owner for MVP.
_Avoid_: Giver, client

**Worker**:
A Member accepted to perform work on a Quest.
_Avoid_: Hunter, candidate, assignee

**Candidate**:
A Member or team that has applied to a Candidate Quest but has not been accepted as a Worker.
_Avoid_: Chat member, assigned Worker

**Candidate Team**:
A forming group of Candidates for one `GROUP + CANDIDATE` Quest. A submitted
Candidate Team is the unit the Hirer selects.
_Avoid_: Work Conversation, Active Workers before selection.

**Team Leader**:
The Worker who represents a Candidate `GROUP` Team. The Team Leader starts and
submits or confirms the Team's required work.
_Avoid_: treating a Team Leader as the Hirer or as a leader of a FCFS Group.

**First Come, First Served (FCFS)**:
A Quest selection mode where an eligible Worker joins directly. It replaces the
legacy `NO_CANDIDATE` name, which describes an absence instead of the selection
rule.
_Avoid_: `NO_CANDIDATE` in new contracts, treating FCFS as a third Quest mode.

**Prospective Worker**:
A Member who is considering work on a Quest but does not have an active Assignment for that Quest. A Prospective Worker may be a Candidate or a Member considering a direct join.
_Avoid_: Worker, Accepted Participant

**Join Code**:
A Server-generated temporary code that lets an eligible Prospective Worker join
a forming Candidate Team.
_Avoid_: an invitation, a permanent shared secret.

**Accepted Participant**:
The current Hirer or an Active Worker. Only Accepted Participants have current Work Conversation membership.
_Avoid_: Candidate, departed Worker

**Quest**:
One bounded agreement for work, owned by one Hirer and progressing through its lifecycle. Target lifecycle and `dueAt` rules are defined in `docs/rulebook/quest/quest-work-chat-rulebook.md`.
_Avoid_: Job, task

**Quest Image**:
An optional ordered image in a Quest's detail gallery. The `Hirer` owns it
through the Quest, and it is not a Chat Attachment. The `/api/v2` contract
accepts valid JPEG, PNG, or WebP files up to 5 MB each, with at most three
images per Quest. Upload and remove are allowed only while the Quest is
`QUEST_DRAFT`; the API uses `imageId`, returns a 15-minute temporary link, and
soft-deletes removed file metadata. Quest Images are not shown on the Quest
Board card.
_Avoid_: image URL, Chat Attachment, treating an image as required for publish.

**Underfilled GROUP + FCFS Quest**:
A `GROUP + FIRST_COME_FIRST_SERVED` Quest at `startTime` with fewer Active
Workers than `headcount`.
_Avoid_: an open Quest with no accepted Worker, an incomplete Candidate Team.

**dueAt**:
The deadline for the required Worker action on a Quest. The Server decides
whether the action arrived on time. It cannot change after the Quest is
assigned. Target deadline, reminder, and failure rules are defined in
`docs/rulebook/quest/quest-work-chat-rulebook.md`.
_Avoid_: client-side deadline, approximate deadline.

**Quest Condition**:
A set of separate requirements that define what a Worker must complete for a Quest. Condition size, ordering, visibility, and editing rules are defined in `docs/rulebook/quest/quest-work-chat-rulebook.md`.
_Avoid_: condition text, Quest rule

**Condition Item**:
One ordered requirement within a Quest Condition. Its validation and Quest Edit rules are defined in `docs/rulebook/quest/quest-work-chat-rulebook.md`.
_Avoid_: condition field

**Assignment**:
The accepted participation of one Worker in a Quest. It is the canonical record that a Worker is working on that Quest.
_Avoid_: Application, team membership

**Start Work**:
The required starter's action that changes an assigned Quest to in progress.
_Avoid_: a readiness signal, a Proof Submission.

**Proof Submission**:
A record of required work submitted by a Worker or Team Leader when the Quest
requires proof. It is separate from Chat Messages and has one decision. Its
fields, lifecycle, visibility, and UI rules are defined in
`docs/rulebook/quest/quest-work-chat-rulebook.md`.
_Avoid_: Work Message, treating proof as an ordinary Chat Message

**Active Worker**:
A Worker whose Assignment has not ended.
_Avoid_: Candidate, former Worker

**Departed Worker**:
A former Active Worker whose Assignment ended before the Quest completed.
_Avoid_: Active Worker, Candidate

**Work Membership Window**:
The inclusive period in which an Accepted Participant has current access to the Work Conversation. After the window ends, the former Worker may read only Messages created no later than their departure and cannot send or receive new Messages.
_Avoid_: Chat permission, participant status

**Quest Edit**:
A proposed change to a Quest Condition by its Hirer. The target timing, response, diff, and Quest State rules are defined in `docs/rulebook/quest/quest-work-chat-rulebook.md`.
_Avoid_: Assignment change, membership transition

**Conversation**:
A persisted private room for one Quest. The target has two Conversation types: Candidate Inquiry Conversation and Work Conversation.
_Avoid_: Direct message, group chat, team chat

**Candidate Inquiry Conversation**:
A private one-to-one Conversation between the Hirer and one Prospective Worker to clarify unclear Quest details while any Quest is `QUEST_OPEN` (across all selection modes and participation shapes). It becomes inaccessible when that Member gets an active Assignment, the Quest enters `QUEST_ASSIGNED`, or the Quest is cancelled before assignment; it never becomes a Work Conversation.
_Avoid_: DM as a domain type, Work Conversation, public Quest comment

**Work Conversation**:
The one Chat Conversation for coordinating work on a Quest, created when the first Worker gets an active Assignment. Current members are the Hirer and Active Workers; Candidates and Prospective Workers never join it. The target membership, Message, Attachment, read, UI, offline, and Rate Limit rules are defined in `docs/rulebook/quest/quest-work-chat-rulebook.md`.
_Avoid_: Group chat, team chat

**Chat Membership**:
The relationship between an Accepted Participant and a Work Conversation. It records whether the Accepted Participant may read current content, send Messages, and retain historical access after departure.
_Avoid_: Chat permission, participant status

**Message**:
A piece of immutable content in a Conversation, sent by a permitted participant or created by the system. The target text, Attachment, ordering, visibility, and retry rules are defined in `docs/rulebook/quest/quest-work-chat-rulebook.md`.
_Avoid_: Notification, post

**Attachment**:
A private image, PDF, or video file shared in a Message. The target access, size, link, device-open, and upload-failure rules are defined in `docs/rulebook/quest/quest-work-chat-rulebook.md`.
_Avoid_: Public file, image URL

**Read Cursor**:
A private position that a Member has acknowledged in a Conversation. It is not a Read Receipt. The target movement and unread-count rules are defined in `docs/rulebook/quest/quest-work-chat-rulebook.md`.
_Avoid_: Read receipt, last seen

**System Message**:
A system-created immutable Message that records a membership or Quest workflow Event and appears from KU bot. The target template, visibility, action-link, Popup, and notification rules are defined in `docs/rulebook/quest/quest-work-chat-rulebook.md`.
_Avoid_: Notification, audit log

**Audit Record**:
An immutable internal record of a domain or money change. The target covered records, fields, visibility, and retention rules are defined in `docs/rulebook/quest/quest-work-chat-rulebook.md`.
_Avoid_: System Message, editable history

**Push Notification**:
A short out-of-app alert for a Quest Event. Production targets Android through FCM; the target recipient, device, retry, deduplication, mute, foreground, and privacy rules are defined in `docs/rulebook/quest/quest-work-chat-rulebook.md`.
_Avoid_: System Message, treating a push alert as Chat history

**Push Device**:
An Android device registered by a Member to receive Push Notifications, managed as an independent destination that can be disabled without disabling the Member's other devices. Only an authenticated Member can register or disable that Member's Push Device.
_Avoid_: phone number, treating one Member as one device

**Report Case**:
A Trust & Safety record that groups Reporter Entries for one Message and tracks its moderation status: `REPORT_CASE_PENDING`, `REPORT_CASE_DISMISSED`, `REPORT_CASE_HIDDEN`, or `REPORT_CASE_RESTORED`. `REPORT_CASE_PENDING` and `REPORT_CASE_HIDDEN` are open statuses; `REPORT_CASE_DISMISSED` and `REPORT_CASE_RESTORED` are closed statuses. A new Reporter Entry against a Message whose most recent Report Case is closed opens a new Report Case rather than reopening the old one. It retains the bounded evidence needed by moderation while open; rules are defined in `docs/rulebook/admin/admin-rulebook.md`.
_Avoid_: single Reporter Entry, Message flag, the superseded bare `PENDING`/`DISMISSED`/`HIDDEN`/`RESTORED` values

**Conduct Report**:
A Member's report about how another Member behaved on one Quest, chosen from a fixed reason list scoped to the pair's roles. Its evidence is the Quest record — the Assignment, the Proof Submission, and their times — not a Message, so it is a separate record from a Report Case: the clearest case is an unreachable Worker, where the complaint is that no Message exists. A Conduct Report an Admin upholds counts as a confirmed violation on the same penalty ladder as a hidden Message. Reasons, filers, timing, notifications, and decision rules are defined in `docs/rulebook/admin/admin-rulebook.md`.
_Avoid_: Report Case (that is about one Message's content), Reporter Entry, treating abusive language as a Conduct Report reason — that opens a Report Case.

**Evidence Reference**:
A bounded reference from a Report Case to a Message or Attachment required for moderation. It identifies the retained domain record and its hold without copying Message text, file bytes, or signed URLs.
_Avoid_: evidence copy, public file link

**Reporter Entry**:
A Member's reason and optional detail about one visible Message. A Member can create one Reporter Entry for one Message, and the entry belongs to that Message's Report Case.
_Avoid_: Report Case, Moderation Decision

**Moderation Decision**:
An immutable record of an Admin's decision to dismiss, hide, or restore a Report Case. It records the previous status, the new status, the Admin, and the time of the decision.
_Avoid_: Reporter Entry, Admin Action

**Admin Action**:
An immutable audit record of an Admin's Work Chat evidence access or moderation operation. It records the action and result for the affected domain records without storing Message text, file bytes, or signed URLs.
_Avoid_: Reporter Entry, Moderation Decision

**Admin Review Item**:
A system-created record for sending a confirmed `PROOF_NOT_APPROVED` decision to an Admin for review. It links the Quest, Assignment, Proof Submission, decision reason, and evidence references; it does not reopen the Quest or create Rework. It is one way an Admin learns a Dispute Case is warranted, but an Admin may open one without it; see `docs/rulebook/admin/admin-rulebook.md`.
_Avoid_: Report Case, Admin override

**Dispute Case**:
A review opened by the Hirer, a Worker, or an Admin acting for a Worker, within a fixed window after a Failed Quest, that may redirect part of the Hirer's returned settlement to a Worker. It does not reopen or change the Quest State, and never reclaims a Reward already transferred to a Worker. Actors, timing, and decision rules are defined in `docs/rulebook/admin/admin-rulebook.md`.
_Avoid_: Admin Review Item, `QUEST_DISPUTED`

**Terminal Quest**:
A Quest in `QUEST_COMPLETED`, `QUEST_CANCELLED`, or
`QUEST_FAILED`. Its Work Conversation is read-only for Members, but the
system may append System Messages for later workflow events.
_Avoid_: Closed conversation

**Failed Quest**:
A Quest that ends because a Proof Submission was not approved or required proof was not submitted in time. It is terminal and has no Rework process.
_Avoid_: Cancelled Quest, treating failed work as a cancellation

**Work Membership Transition**:
A change to Accepted Participant membership or terminal lifecycle state that changes Work Conversation membership or write access.
_Avoid_: Chat event, message event

## Consumers

- **KUQuest Mobile** — Expo app, uses native Google Sign-In (not a webview redirect) to reach this API.
- **KUQuest Admin** — Next.js admin/CMS web frontend.

## Response shape

Every endpoint returns the shared envelope defined in `src/shared/api-response.ts` / `api-response.schema.ts`: `{ success: true, data? }` or `{ success: false, error: { code, message } }`. See `ApiResponse`, `ApiSuccess`, `ApiError`.
