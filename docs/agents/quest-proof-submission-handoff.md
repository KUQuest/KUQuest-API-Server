# Quest v2 Proof Submission Handoff

This document is the focused HTTP handoff for the Quest v2 Proof Submission branch.
It covers Worker draft and send actions, Hirer review, Proof file access, state
changes, errors, and verification.

This is an implementation handoff. The accepted policy remains authoritative:

- `CONTEXT.md` for KUQuest vocabulary.
- `docs/rulebook/quest/proof-submission-contract.md` for Proof Submission policy.
- `docs/rulebook/quest/quest-work-chat-rulebook.md` for Quest lifecycle policy.

## 1. Branch guard

Use this branch only when all facts below are known:

- Actor: `Worker`, `Team Leader`, or `Hirer`.
- Quest State: normally `QUEST_IN_PROGRESS` for Worker send actions.
- Quest mode: `FIRST_COME_FIRST_SERVED` or `CANDIDATE`.
- Participation: `SINGLE` or `GROUP`.
- `proofRequired` and `dueAt`.

When `proofRequired=false`, do not create or review a Proof Submission. The
required submitter uses the separate completion-confirmation path.

All routes in this document require an authenticated Member session. The Server
checks the Member's Quest relationship. A client-side role check is not
authorization.

## 2. Proof Submission state

| Proof Submission state | Meaning                                  | Mutable by Worker?   |
| ---------------------- | ---------------------------------------- | -------------------- |
| `null`                 | Unsent Draft.                            | Yes, before `dueAt`. |
| `PROOF_PENDING`        | Sent and waiting for the Hirer decision. | No.                  |
| `PROOF_APPROVED`       | Final approval recorded.                 | No.                  |
| `PROOF_NOT_APPROVED`   | Final non-approval recorded.             | No.                  |

A Draft has both `status = null` and `submittedAt = null`. A sent Proof has a
non-null `status` and `submittedAt`.

There is no `PROOF_REJECTED` state and no Rework path.

### Send-time state transition

A successful Worker send performs only this Proof Submission update:

```text
status:       null            -> PROOF_PENDING
submittedAt:  null            -> current Server time
updatedAt:    previous value  -> current Server time
```

The Quest remains `QUEST_IN_PROGRESS`.
The relevant Assignment remains `ASSIGNMENT_ACTIVE`.
The Proof becomes locked.
No Reward is settled at send time.

## 3. Common HTTP rules

### Response envelope

Success:

```json
{ "success": true, "data": {} }
```

Error:

```json
{
  "success": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable message"
  }
}
```

Read business values from `data`. Branch on `error.code`, not on the message.

### Idempotency

Every state-changing route requires a unique, non-blank header:

```http
Idempotency-Key: unique-client-action-id
```

Use the same key and the same request body when retrying an uncertain request.
Use a new key for a new logical action. A reused key with a different request
fingerprint returns an idempotency error.

State-changing routes in this document are:

- Create Draft.
- Edit Draft.
- Delete Draft.
- Send Draft.
- Review Proof.

### Deadline

The Server's `dueAt` is authoritative. A Worker must complete Draft writes and
send the Proof before `dueAt`. Do not use client time to accept a late action.

## 4. Endpoint catalog

### 4.1 Create a Draft — Worker

```http
POST /api/v2/quests/{questId}/proof-submissions
Idempotency-Key: create-proof-{clientActionId}
Content-Type: application/json
```

Example:

```json
{
  "description": "Completed the required work.",
  "workerMessage": "The final files are attached.",
  "fileIds": ["file-uuid"]
}
```

The route also accepts `multipart/form-data` for new file uploads. A Draft can
contain up to five files. The description is optional and has a maximum length
of 1,000 characters. `workerMessage` is optional and has a maximum length of
200 characters. At least one non-blank description, worker message, or file is
required by the current implementation.

A successful response returns a Proof Submission with `status: null`.

### 4.2 Edit a Draft — Worker

```http
PATCH /api/v2/quests/{questId}/proof-submissions/{proofSubmissionId}
Idempotency-Key: edit-proof-{clientActionId}
Content-Type: application/json
```

Example:

```json
{
  "description": "Updated work description.",
  "fileIds": ["file-uuid-1", "file-uuid-2"]
}
```

Only the required submitter can edit an unsent Draft before `dueAt`. The request
body must contain at least one property. A submitted Proof cannot be edited.

For a failed upload position, use the multipart retry flow with exactly one
replacement file and its zero-based `retryPosition`.

### 4.3 Delete a Draft — Worker

```http
DELETE /api/v2/quests/{questId}/proof-submissions/{proofSubmissionId}
Idempotency-Key: delete-proof-{clientActionId}
```

There is no business body. Only an unsent Draft can be deleted.

### 4.4 Send a Draft — Worker

```http
POST /api/v2/quests/{questId}/proof-submissions/{proofSubmissionId}/submit
Idempotency-Key: submit-proof-{clientActionId}
```

The request has no business body. The Draft must have at least one ready file
and no failed file position. The required submitter must be an active Worker or
Team Leader, and the send must arrive before `dueAt`.

Success returns the locked Proof:

```json
{
  "success": true,
  "data": {
    "id": "proof-uuid",
    "status": "PROOF_PENDING",
    "submittedAt": "2026-09-23T10:00:00.000Z"
  }
}
```

### 4.5 List Proof Submissions — Hirer or permitted Member

```http
GET /api/v2/quests/{questId}/proof-submissions
```

The Hirer receives sent Proof Submissions with `visibility: "FULL"`. The
submitter receives their own Proof with full visibility. A permitted participant
can receive a role-filtered `SUMMARY` view.

Unsent Drafts are visible only to the submitter. Therefore, the Hirer detects a
Worker send with:

```ts
submission.status === 'PROOF_PENDING' && submission.submittedAt !== null;
```

The current API has no separate GET route for one Proof Submission. Load the
list and select the item by `id`.

### 4.6 Get a temporary Proof file link — Hirer or submitter

```http
GET /api/v2/quests/{questId}/proof-submissions/{proofSubmissionId}/files/{fileId}
```

The response contains a short-lived URL:

```json
{
  "success": true,
  "data": {
    "fileId": "file-uuid",
    "contentType": "application/pdf",
    "sizeBytes": 12345,
    "position": 0,
    "url": "https://storage.example/file",
    "urlExpiresAt": "2026-09-23T10:15:00.000Z"
  }
}
```

Do not persist the temporary URL as a permanent file reference. Request a new
link after it expires.

### 4.7 Review a Proof — Hirer

```http
POST /api/v2/quests/{questId}/proof-submissions/{proofSubmissionId}/review
Idempotency-Key: review-proof-{clientActionId}
Content-Type: application/json
```

Approve:

```json
{ "decision": "PROOF_APPROVED" }
```

Do not approve:

```json
{
  "decision": "PROOF_NOT_APPROVED",
  "reason": "The submitted work is incomplete."
}
```

Only the owning Hirer can review. The first final decision wins. A reason is
required for `PROOF_NOT_APPROVED` and is limited to 1,000 characters. A reason
is invalid for `PROOF_APPROVED`.

Success response:

```json
{
  "success": true,
  "data": {
    "proof": {
      "id": "proof-uuid",
      "status": "PROOF_APPROVED"
    },
    "questStatus": "QUEST_COMPLETED"
  }
}
```

## 5. Hirer review flow

1. Read `GET /api/v2/quests/{questId}` for the current Quest State and
   `proofRequired`.
2. Read `GET /api/v2/quests/{questId}/proof-submissions`.
3. Select each `PROOF_PENDING` Proof Submission.
4. Request each required file link.
5. Show the description, Worker message, and evidence.
6. Send one final review command.
7. Replace local Proof and Quest State with the review response.
8. Refresh the list after a conflict or an uncertain response.

A `PROOF_PENDING` item means that the Worker sent work. It does not mean that
the work passed review.

## 6. Review effects

### Approval

`PROOF_APPROVED` runs approval settlement:

- The relevant Assignment becomes `ASSIGNMENT_COMPLETED`.
- The Worker receives the applicable Quest Reward.
- The Quest becomes `QUEST_COMPLETED` when no Active Worker remains.
- A Group Quest can remain `QUEST_IN_PROGRESS` while another Active Worker
  remains.
- Approval of a valid pending Proof after the Quest already failed keeps the
  Quest `QUEST_FAILED` while settling the approved Worker according to policy.

### Non-approval

`PROOF_NOT_APPROVED`:

- Makes the relevant Assignment `ASSIGNMENT_INCOMPLETE`.
- Makes the Quest `QUEST_FAILED` immediately.
- Gives that Worker no Quest Reward.
- Creates exactly one Admin Review Item.
- Does not reopen the Quest.
- Does not create Rework.
- Does not allow a second Proof Submission.

### Automatic approval

If the Hirer does not decide within 24 hours after `submittedAt`, the lifecycle
worker records `PROOF_APPROVED` and uses the same approval settlement path.

## 7. Error handling

Use `error.code` to select the UI action.

| Code                                 | Meaning                                                   | Client action                                                            |
| ------------------------------------ | --------------------------------------------------------- | ------------------------------------------------------------------------ |
| `PROOF_SUBMISSION_NOT_ALLOWED`       | Caller is not the required submitter.                     | Stop the Worker action and reload authorization state.                   |
| `PROOF_REVIEW_NOT_ALLOWED`           | Caller is not the Quest Hirer.                            | Hide review controls.                                                    |
| `PROOF_SUBMISSION_NOT_FOUND`         | Quest or Proof ID is not visible.                         | Reload the Quest and list.                                               |
| `QUEST_NOT_IN_PROGRESS`              | Worker write is outside the active work State.            | Render the returned Quest State.                                         |
| `QUEST_NOT_REVIEWABLE`               | Hirer review is not valid in the current Quest State.     | Reload Quest and Proof list.                                             |
| `PROOF_DUE_AT_REQUIRED`              | Quest has no Proof deadline.                              | Treat the Quest configuration as invalid.                                |
| `PROOF_DUE_AT_PASSED`                | Worker action arrived after `dueAt`.                      | Stop the action and show the deadline result.                            |
| `PROOF_SUBMISSION_LOCKED`            | The Proof was already sent.                               | Disable edit and delete controls.                                        |
| `PROOF_SUBMISSION_NOT_SENT`          | Hirer tried to review a Draft.                            | Reload the list.                                                         |
| `PROOF_REVIEW_NOT_PENDING`           | A final review already exists.                            | Treat the stored decision as authoritative.                              |
| `PROOF_FILES_REQUIRED`               | Send has no ready file.                                   | Return the Worker to Draft editing.                                      |
| `PROOF_FILES_UPLOAD_FAILED`          | A failed upload position remains.                         | Retry or remove the failed file.                                         |
| `PROOF_FILES_INVALID`                | A file is missing, deleted, unauthorized, or invalid.     | Reload file state and repair the Draft.                                  |
| `PROOF_DRAFT_INVALID`                | Draft content is blank or outside limits.                 | Show field validation.                                                   |
| `PROOF_NOT_APPROVED_REASON_REQUIRED` | Non-approval has no reason.                               | Require a non-blank reason.                                              |
| `PROOF_REVIEW_REASON_INVALID`        | Review reason is too long or conflicts with the decision. | Correct the reason or remove it for approval.                            |
| `PROOF_REVIEW_DECISION_INVALID`      | Decision is not one of the two allowed values.            | Send only an allowed decision.                                           |
| `IDEMPOTENCY_KEY_REUSED`             | Same key has a different request fingerprint.             | Keep the original key for a retry, or create a new key for a new action. |

## 8. Current implementation map

| Concern                                            | Source                                                     |
| -------------------------------------------------- | ---------------------------------------------------------- |
| Route registration and endpoint paths              | `src/modules/quest/v2/proof/quest-proof-v2.route.ts`       |
| HTTP response and error mapping                    | `src/modules/quest/v2/proof/quest-proof-v2.controller.ts`  |
| Draft, send, list, review, and auto-approval logic | `src/modules/quest/v2/proof/quest-proof-v2.service.ts`     |
| Request and response schemas                       | `src/modules/quest/v2/proof/quest-proof-v2.schema.ts`      |
| Proof Submission and file tables                   | `src/database/schema/quest.schema.ts`                      |
| Reward settlement and Quest State effects          | `src/modules/quest/settlement/quest-settlement.service.ts` |
| Due-time failure and automatic approval scheduling | `src/modules/quest/lifecycle/quest-lifecycle.worker.ts`    |
| Accepted Proof policy                              | `docs/rulebook/quest/proof-submission-contract.md`         |

## 9. Verification checklist

A Proof Submission integration is complete when all items below are true:

- The Worker can create a valid Draft.
- The Worker can edit and delete only an unsent Draft.
- The Worker cannot send a Draft with no ready file or a failed file position.
- A successful send returns `PROOF_PENDING` and locks the Proof.
- The Hirer can list sent Proof Submissions with full visibility.
- The Hirer can open each ready file through a temporary link.
- Only the owning Hirer can record the first final decision.
- Non-approval requires a reason.
- Approval and non-approval return the resulting Quest State.
- The UI renders the Server's Proof and Quest State instead of calculating them.
- Retries reuse the same idempotency key.
- The integration covers approval, non-approval, automatic approval, deadline
  failure, invalid files, locked Drafts, and review conflicts.
