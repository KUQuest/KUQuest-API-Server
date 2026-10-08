# Admin Member Penalty Contract

Part of the [Admin Rulebook](admin-rulebook.md). Defines accepted policy for the Misconduct penalty ladder, Low-Average-Review ladder, direct Admin penalty actions, Red Flags, Member Bans, and the `memberPenaltyRecord` audit trail.

## Two independent ladders

Member penalties operate through two independent ladders. A Member's strike count on one never affects the other.

---

## 1. Misconduct ladder

The automatic Misconduct ladder is triggered when an Admin confirms a violation:

- a `REPORT_CASE_HIDDEN` Moderation Decision on a sent Message; or
- a `CONDUCT_REPORT_UPHELD` decision on a Quest Conduct Report.

### Penalty tiers

| Misconduct ladder strike | Result                             | Duration         |
| ------------------------ | ---------------------------------- | ---------------- |
| 1st strike               | Red Flag                           | 7 days (`PC-09`) |
| 2nd strike               | Temporary ban + Wallet Auto-Freeze | 7 days (`PC-11`) |
| 3rd strike               | Permanent ban                      | Permanent        |

### Rules and exemptions

- **Red Flag**: Visible on Member Profile, mini-profile during Candidate selection, and Hirer identity on Quest pages. Blocks applying as Candidate, joining FCFS Quests, and **publishing new Quests**. Runs existing Quests unchanged. Expires automatically after 7 days without Admin intervention.
- **Temporary ban (2nd strike)**: Denies sign-in for 7 days. Auto-freezes Wallet in the same action; auto-restores Wallet to `ACTIVE` upon expiry.
- **Permanent ban (3rd strike)**: Denies sign-in permanently and auto-freezes Wallet. Read directly from `memberPenaltyRecord`.
- **Report Case exemption**: The first confirmed `REPORT_CASE` for a Member receives `PENALTY_EXEMPT`. A Conduct Report does not use or consume this exemption. The exemption stays consumed after `REPORT_CASE_RESTORED`; a later Report Case advances the Misconduct ladder.
- **Conduct Reports**: Every newly upheld `CONDUCT_REPORT` advances the Misconduct ladder. There are no first-10 or post-Ban exemptions. Existing `PENALTY_EXEMPT` Conduct Report records remain unchanged and do not count as strikes.
- **Report Case decisions**: A Report Case dismissed before Hide creates no penalty record and does not consume the exemption. Dismissing a hidden Report Case keeps its penalty record. `REPORT_CASE_RESTORED` reverses the penalty created by its earlier `REPORT_CASE_HIDDEN` decision; reversal does not return the exemption.
- **Prospective case-decision policy**: The source-specific exemption rules apply to new decisions. Existing penalty records are not reclassified.
- **Penalty removal**: A separate Admin action may remove any effective penalty record from any source. This includes a Conduct Report strike, which cannot be reversed by a Conduct Report decision. It does not change the source decision.
- **Direct Admin results**: A direct Admin-selected result does not count toward later automatic Misconduct ladder results.
- **Assignments during bans**: A banned Member's active Assignments are not force-cancelled. The standard deadline and Start Work rules apply; unfulfilled work fails via standard rules.

---

## 2. Low-Average-Review ladder

Fully automatic system evaluation (not Admin-triggered):

| Downward crossing count | Result        | Duration  |
| ----------------------- | ------------- | --------- |
| 1st strike              | Temporary ban | 7 days    |
| 2nd strike              | Temporary ban | 1 month   |
| 3rd strike              | Permanent ban | Permanent |

### Rules

- Triggers only once a Member has received at least **10 Reviews**.
- From the 10th Review onward, each time a new Review causes the Member's running average rating to cross from &ge;3.0 down to below 3.0, that crossing counts as one violation.
- Further Reviews received while the average remains below 3.0 do not increment the count. A new strike occurs only on subsequent downward crossings after recovering to &ge;3.0.
- The Report Case exemption and Conduct Report rules do not apply to this ladder.
- Evaluated only upon Review creation. Review edits within the 7-day window update displayed ratings but never alter recorded strikes.

---

## 3. Direct Admin penalty actions

### Add a penalty

- **Record violation** is a direct Admin action. It does not require a Report Case or Conduct Report.
- The Admin selects one permitted Misconduct result: `PENALTY_RED_FLAG`, `PENALTY_TEMPORARY_BAN_7_DAYS`, or `PENALTY_PERMANENT_BAN`. The 1-month Temporary ban belongs only to the automatic Review ladder.
- The existing direct-action exemptions remain in effect. `PC-12` exempts the first 10 confirmed violations after account creation. `PC-13` exempts the first 3 confirmed violations after a temporary or permanent ban lifts. If an exemption applies, no penalty is added and the Admin cannot select a penalty.
- The Add command records an exempt `PENALTY_EXEMPT` history row when `PC-12` or `PC-13` applies. It rejects a selected result in that case. When no exemption applies, the Admin must select one permitted result.
- Direct-action exemption counts include confirmed Misconduct events from Report Cases, Conduct Reports, and earlier direct Record violation actions. Review events do not count. A direct Record violation counts toward later direct-action exemption checks.
- A direct Admin-selected result stays as selected. It does not count toward later automatic Misconduct ladder results, and recalculation does not change it.
- Add reason codes are `MEMBER_PENALTY_VIOLATION_CONFIRMED`, `MEMBER_PENALTY_REPEATED_VIOLATION_CONFIRMED`, `MEMBER_PENALTY_SAFETY_RISK_CONFIRMED`, and `MEMBER_PENALTY_OTHER_VIOLATION_CONFIRMED`.
- The Admin must select an Add reason code. An optional Admin note has a maximum of 200 characters and appears in Penalty History.

### Remove a penalty

- An Admin may remove any effective penalty record from any source, including `REPORT_CASE`, `CONDUCT_REPORT`, `REVIEW_AVERAGE`, and a direct Admin action.
- An effective penalty record is an original, non-exempt record that has not been reversed. It remains effective in the ladder after its timed restriction expires.
- Removal appends a linked reversal record. It does not edit or delete the original record, and it does not change the source Report Case, Conduct Report, or Review decision.
- The API recalculates the Member's current restrictions and penalty-created Wallet state from the remaining effective records. A separate discretionary Wallet Freeze or Wallet Suspend remains in place.
- The API recalculates later automatic ladder results from the remaining effective history. If a result changes, the API appends a linked reversal for the old result and a linked replacement with the recalculated result. It does not edit or delete either record. Direct Admin-selected results stay as selected and do not count toward automatic Misconduct ladder results.
- Remove reason codes are `MEMBER_PENALTY_ADMIN_ERROR`, `MEMBER_PENALTY_NEW_EVIDENCE`, `MEMBER_PENALTY_POLICY_REVIEW`, and `MEMBER_PENALTY_OTHER_CORRECTION`.
- The Admin must select a Remove reason code. An optional Admin note has a maximum of 200 characters and appears in Penalty History.
- Penalty History exposes a version token and marks whether each penalty record is effective.
- `GET /api/v1/admin/members/:id/penalty-history` exposes `versionToken`, an integer equal to the current immutable history row count, and marks whether each penalty record is effective. Every appended command, reversal, or recalculated result advances the token.
- `POST /api/v1/admin/members/:id/penalty-actions/add` and `/remove` require `expectedVersionToken` and an `Idempotency-Key` header. The API rejects a stale token, rejects reuse of a key with a different request, and replays a retry with the original result and version token.
- Add and Remove are audited in `memberPenaltyRecord`. They do not create a separate `AdminAction` record.

## 4. Data shape and persistence

- `authUser.bannedUntil` (nullable timestamp): Projected later expiry of temporary bans from both ladders for O(1) auth guard evaluation.
- `authUser.redFlagExpiresAt` (nullable timestamp): Projected Red Flag expiry.
- `memberPenaltyRecord` (immutable audit table): Source of truth for penalties, recording Member, ladder (`MISCONDUCT` | `REVIEW`), source (`REPORT_CASE`, `CONDUCT_REPORT`, `REVIEW_AVERAGE`, or direct Admin action), sequence number, result, actor, reason code, optional Admin note, timestamp, and nullable reversal and recalculation links.
