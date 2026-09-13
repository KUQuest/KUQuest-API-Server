# Quest Lifecycle Worker Operations

This runbook describes how to execute, verify, and schedule the Quest Lifecycle Worker.
The worker processes time-dependent Quest transitions and releases reserved funds.

## Context and References

- Worker script: `scripts/quest-lifecycle-worker.ts`
- Worker core module: `src/modules/quest/quest-lifecycle.worker.ts`
- Quest and Work Chat rulebook: `docs/rulebook/quest/quest-work-chat-rulebook.md`
- Dispute hold decision: `docs/adr/0024-hold-quest-failure-settlement-for-dispute-window.md`

## Worker Responsibilities

The worker executes these lifecycle transitions in order:

1. **Auto-approve Proofs**: Records `PROOF_APPROVED` when the 24-hour Proof Review Window expires without Hirer action.
2. **Fail Overdue Quests**: Moves Quests to `QUEST_FAILED` when `dueAt` expires without approved proof.
3. **Release Failure Holds**: Releases the Hirer's Funding Reservation after the dispute window expires.
4. **Time Out Edit Requests**: Expires pending Quest Edit requests past their deadline.
5. **Handle Underfilled Quests**: Cancels underfilled `GROUP` Quests and releases the Hirer's Quest Escrow.
6. **Start Quests**: Moves Quests from `QUEST_ASSIGNED` to `QUEST_IN_PROGRESS` when `startTime` arrives.
7. **Expire Invitations**: Cancels expired team invitations.

## Prerequisites

- Set `DATABASE_URL` with read and write permissions to PostgreSQL.
- Verify migration status before you run the worker:
  ```bash
  bun run db:check
  ```
- Ensure PostgreSQL accepts incoming connections.

## 1. Execute Single Pass

### Command

Execute one worker pass manually:

```bash
bun run worker:quest-lifecycle
```

### Verification

1. Verify that the process exits with exit code `0`.
2. Verify that standard output contains a valid JSON payload:
   ```json
   {
     "startedQuestIds": [],
     "autoCancelledQuestIds": [],
     "underfilledQuestIds": [],
     "timedOutUnderfilledQuestIds": [],
     "failedQuestIds": [],
     "releasedFailedQuestIds": [],
     "timedOutEditRequestIds": [],
     "expiredInvitationIds": [],
     "autoApprovedProofIds": [],
     "errors": []
   }
   ```
3. Verify that the `errors` array is empty.

### Recovery

If the command exits with exit code `1`:

1. Read the error log in standard error.
2. Check database connectivity:
   ```bash
   bun run db:check
   ```
3. If an individual Quest causes an error, read the operation name and ID from `errors`:
   ```text
   operation: "due-at-failure"
   id: "<quest-id>"
   cause: "<database error detail>"
   ```
4. Fix the invalid record in PostgreSQL before you execute the command again.

## 2. Schedule Continuous Execution

Deploy the worker as a continuous background job on staging and production servers.

### Execution Interval

- Execute the worker every 60 seconds.

### Concurrency Rule

- Do not execute concurrent worker instances against the same database schema.
- Use `flock` or an orchestrator lock to prevent overlapping runs.

### Example Cron Configuration

```cron
* * * * * cd /opt/backend && /usr/bin/flock -n /tmp/quest-worker.lock bun run worker:quest-lifecycle >> /var/log/quest-worker.log 2>&1
```

## 3. Database State Invariants

Run these SQL queries to verify that no expired records remain unhandled:

### Invariant 1: No Overdue In-Progress Quests

This query must return zero rows:

```sql
SELECT id, quest_status, due_at
FROM quest
WHERE quest_status = 'QUEST_IN_PROGRESS'
  AND due_at < NOW();
```

### Invariant 2: No Overdue Pending Proofs

This query must return zero rows:

```sql
SELECT id, quest_id, sent_at
FROM quest_v2_proof_submission
WHERE submission_status = 'PROOF_PENDING'
  AND sent_at < NOW() - INTERVAL '24 hours';
```

### Invariant 3: No Overdue Assigned Quests

This query must return zero rows:

```sql
SELECT id, quest_status, start_time
FROM quest
WHERE quest_status = 'QUEST_ASSIGNED'
  AND start_time <= NOW();
```

## 4. Emergency Escrow Release

If the worker stops unexpectedly during failure settlement, funds remain reserved.

### Recovery Steps

1. Execute a dedicated worker pass:
   ```bash
   bun run worker:quest-lifecycle
   ```
2. Verify that `releasedFailedQuestIds` contains the IDs of the failed Quests.
3. Verify that the corresponding `wallet_funding_reservation` records change status to `RELEASED`.
4. Verify that the Hirer's Spending Balance reflects the returned funds.
