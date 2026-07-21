/* oxlint-disable typescript/no-unsafe-type-assertion -- SQL rows and durable JSON are validated at this repository boundary. */
import type { Sql, TransactionSql } from 'postgres';

import { JobError } from './job.errors';
import type {
  CreateApplicationCommand,
  CreateFundedJobCommand,
  FundedJob,
  JobApplication,
  JobApplicationPage,
  JobApplicationStatus,
  JobCommand,
  JobPage,
  JobRepository,
  JobStatus,
  ListJobsQuery,
  PageQuery,
  SelectWorkerCommand,
  SubmitWorkCommand,
  WorkSubmission,
} from './job.types';

interface JobRow {
  id: string;
  employer_user_id: string;
  selected_worker_user_id: string | null;
  title: string;
  description: string;
  amount_baht: string;
  platform_fee_bps: string;
  platform_fee_baht: string;
  worker_net_baht: string;
  policy_revision_id: string;
  status: JobStatus;
  application_deadline_at: Date | string;
  work_deadline_at: Date | string;
  review_deadline_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface ApplicationRow {
  id: string;
  job_id: string;
  worker_user_id: string;
  message: string;
  status: JobApplicationStatus;
  created_at: Date | string;
  updated_at: Date | string;
}

interface IdempotencyRow {
  request_hash: string;
  response_body: unknown;
}

const iso = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

const safeInteger = (value: string, field: string): number => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${field} exceeds the API safe-integer range.`);
  }
  return parsed;
};

const parseOffset = (cursor?: string): number => {
  const offset = cursor ? Number.parseInt(cursor, 10) : 0;
  if (!Number.isInteger(offset) || offset < 0) {
    throw new JobError(422, 'VALIDATION_FAILED', 'Cursor is invalid.');
  }
  return offset;
};

const fundedJob = (row: JobRow): FundedJob => ({
  id: row.id,
  employer_user_id: row.employer_user_id,
  intended_payee_user_id: row.selected_worker_user_id,
  title: row.title,
  description: row.description,
  status: row.status,
  job_amount: safeInteger(row.amount_baht, 'amount_baht'),
  platform_fee_rate_bps: safeInteger(row.platform_fee_bps, 'platform_fee_bps'),
  platform_fee_amount: safeInteger(row.platform_fee_baht, 'platform_fee_baht'),
  worker_net_amount: safeInteger(row.worker_net_baht, 'worker_net_baht'),
  currency: 'THB',
  application_deadline: iso(row.application_deadline_at),
  work_deadline: iso(row.work_deadline_at),
  review_deadline: row.review_deadline_at ? iso(row.review_deadline_at) : null,
  created_at: iso(row.created_at),
  updated_at: iso(row.updated_at),
});

const application = (row: ApplicationRow): JobApplication => ({
  id: row.id,
  job_id: row.job_id,
  worker_user_id: row.worker_user_id,
  status: row.status,
  message: row.message,
  created_at: iso(row.created_at),
  updated_at: iso(row.updated_at),
});

const storedJob = (value: unknown): FundedJob => {
  const candidate = typeof value === 'string' ? JSON.parse(value) : value;
  if (
    !candidate ||
    typeof candidate !== 'object' ||
    !('id' in candidate) ||
    typeof candidate.id !== 'string' ||
    !('status' in candidate) ||
    typeof candidate.status !== 'string' ||
    !('job_amount' in candidate) ||
    typeof candidate.job_amount !== 'number'
  ) {
    throw new Error('Stored job idempotency response is invalid.');
  }
  return candidate as FundedJob;
};

const storedApplication = (value: unknown): JobApplication => {
  const candidate = typeof value === 'string' ? JSON.parse(value) : value;
  if (
    !candidate ||
    typeof candidate !== 'object' ||
    !('id' in candidate) ||
    typeof candidate.id !== 'string' ||
    !('job_id' in candidate) ||
    typeof candidate.job_id !== 'string' ||
    !('status' in candidate) ||
    typeof candidate.status !== 'string'
  ) {
    throw new Error('Stored application idempotency response is invalid.');
  }
  return candidate as JobApplication;
};

const jobSelect = `
  SELECT job.id::text, job.employer_user_id, job.selected_worker_user_id,
         job.title, job.description, job.amount_baht::text,
         job.platform_fee_bps::text, job.platform_fee_baht::text,
         job.worker_net_baht::text, job.policy_revision_id::text, job.status,
         job.application_deadline_at, job.work_deadline_at,
         submission.review_deadline_at, job.created_at, job.updated_at
  FROM jobs job
  LEFT JOIN work_submissions submission ON submission.job_id = job.id
`;

export class PostgresJobRepository implements JobRepository {
  constructor(private readonly database: Sql) {}

  async listJobs(userId: string, query: ListJobsQuery): Promise<JobPage> {
    const offset = parseOffset(query.cursor);
    let rows: JobRow[];
    if (query.scope === 'marketplace') {
      rows = (await this.database.unsafe(
        `${jobSelect}
         WHERE job.status = 'OPEN' AND job.application_deadline_at > now()
           AND ($1::text IS NULL OR job.status = $1)
         ORDER BY job.created_at DESC, job.id DESC LIMIT $2 OFFSET $3`,
        [query.status ?? null, query.limit + 1, offset],
      )) as unknown as JobRow[];
    } else if (query.scope === 'assigned') {
      rows = (await this.database.unsafe(
        `${jobSelect}
         WHERE job.selected_worker_user_id = $1
           AND ($2::text IS NULL OR job.status = $2)
         ORDER BY job.created_at DESC, job.id DESC LIMIT $3 OFFSET $4`,
        [userId, query.status ?? null, query.limit + 1, offset],
      )) as unknown as JobRow[];
    } else {
      rows = (await this.database.unsafe(
        `${jobSelect}
         WHERE (job.employer_user_id = $1 OR job.selected_worker_user_id = $1
                OR EXISTS (SELECT 1 FROM job_applications a
                           WHERE a.job_id = job.id AND a.worker_user_id = $1))
           AND ($2::text IS NULL OR job.status = $2)
         ORDER BY job.created_at DESC, job.id DESC LIMIT $3 OFFSET $4`,
        [userId, query.status ?? null, query.limit + 1, offset],
      )) as unknown as JobRow[];
    }
    return {
      items: rows.slice(0, query.limit).map(fundedJob),
      next_cursor: rows.length > query.limit ? String(offset + query.limit) : null,
    };
  }

  async getJob(userId: string, jobId: string): Promise<FundedJob> {
    const [row] = (await this.database.unsafe(
      `${jobSelect}
       WHERE job.id = $1
         AND (job.status = 'OPEN' OR job.employer_user_id = $2
              OR job.selected_worker_user_id = $2
              OR EXISTS (SELECT 1 FROM job_applications a
                         WHERE a.job_id = job.id AND a.worker_user_id = $2))`,
      [jobId, userId],
    )) as unknown as JobRow[];
    if (!row) throw new JobError(404, 'JOB_NOT_FOUND', 'The job was not found.');
    return fundedJob(row);
  }

  async createFundedJob(command: CreateFundedJobCommand): Promise<FundedJob> {
    return this.database.begin(async (transaction) => {
      const claimed = await this.claimIdempotency(
        transaction,
        command,
        'JOB_CREATE',
      );
      if (claimed.replay) return storedJob(claimed.replay);

      const title = command.title.trim();
      const description = command.description.trim();
      if (!title || !description) {
        throw new JobError(422, 'VALIDATION_FAILED', 'Title and description cannot be blank.');
      }
      const applicationDeadline = new Date(command.applicationDeadline);
      const workDeadline = new Date(command.workDeadline);
      if (
        !Number.isFinite(applicationDeadline.getTime()) ||
        !Number.isFinite(workDeadline.getTime()) ||
        applicationDeadline >= workDeadline
      ) {
        throw new JobError(422, 'INVALID_JOB_DEADLINES', 'Application deadline must precede the work deadline.');
      }

      const [wallet] = (await transaction`
        SELECT id::text, spending_balance_baht::text AS spending_balance, status
        FROM wallets WHERE user_id = ${command.userId} FOR UPDATE
      `) as unknown as Array<{ id: string; spending_balance: string; status: string }>;
      if (!wallet) throw new Error('The authenticated user wallet is not provisioned.');
      if (wallet.status === 'FROZEN') {
        throw new JobError(423, 'WALLET_FROZEN', 'The wallet is frozen.');
      }

      const [policy] = (await transaction`
        SELECT id::text, platform_fee_bps::text, minimum_funded_job_baht::text,
               maximum_funded_job_baht::text, default_application_window_seconds::text
        FROM money_policy_revisions
        WHERE effective_from <= now()
          AND (effective_until IS NULL OR effective_until > now())
        ORDER BY revision DESC LIMIT 1
      `) as unknown as Array<{
        id: string;
        platform_fee_bps: string;
        minimum_funded_job_baht: string;
        maximum_funded_job_baht: string;
        default_application_window_seconds: string;
      }>;
      if (!policy) throw new Error('Money policy is not configured.');
      const minimum = safeInteger(policy.minimum_funded_job_baht, 'minimum_funded_job_baht');
      const maximum = safeInteger(policy.maximum_funded_job_baht, 'maximum_funded_job_baht');
      if (command.amount < minimum || command.amount > maximum) {
        throw new JobError(422, 'JOB_AMOUNT_OUT_OF_RANGE', `Job amount must be between ${minimum} and ${maximum} THB.`);
      }
      const maximumApplicationDeadline = Date.now() +
        safeInteger(policy.default_application_window_seconds, 'default_application_window_seconds') * 1_000;
      if (applicationDeadline.getTime() <= Date.now() || applicationDeadline.getTime() > maximumApplicationDeadline) {
        throw new JobError(422, 'INVALID_JOB_DEADLINES', 'Application deadline must be in the future and within the policy window.');
      }
      if (safeInteger(wallet.spending_balance, 'spending_balance_baht') < command.amount) {
        throw new JobError(422, 'INSUFFICIENT_SPENDING_BALANCE', 'The wallet does not have enough spending balance.');
      }

      const accounts = (await transaction`
        SELECT id::text, type FROM ledger_accounts
        WHERE wallet_id = ${wallet.id} AND type IN ('SPENDING', 'JOB_HELD')
        ORDER BY type
      `) as unknown as Array<{ id: string; type: 'SPENDING' | 'JOB_HELD' }>;
      const spendingId = accounts.find((account) => account.type === 'SPENDING')?.id;
      const heldId = accounts.find((account) => account.type === 'JOB_HELD')?.id;
      if (!spendingId || !heldId) throw new Error('Wallet ledger accounts are not provisioned.');

      const feeBps = safeInteger(policy.platform_fee_bps, 'platform_fee_bps');
      const fee = Number((BigInt(command.amount) * BigInt(feeBps) + 9_999n) / 10_000n);
      const jobId = crypto.randomUUID();
      const ledgerTransactionId = crypto.randomUUID();
      await transaction`
        INSERT INTO jobs (
          id, employer_user_id, title, description, amount_baht,
          platform_fee_bps, platform_fee_baht, worker_net_baht,
          policy_revision_id, status, application_deadline_at, work_deadline_at
        ) VALUES (
          ${jobId}, ${command.userId}, ${title}, ${description}, ${command.amount},
          ${feeBps}, ${fee}, ${command.amount - fee}, ${policy.id}, 'OPEN',
          ${applicationDeadline.toISOString()}, ${workDeadline.toISOString()}
        )
      `;
      await this.postLedger(transaction, {
        transactionId: ledgerTransactionId,
        businessReference: `job-funding:${jobId}`,
        eventType: 'JOB_FUNDING',
        idempotencyId: claimed.id,
        userId: command.userId,
        description: 'Funded job published',
        postings: [[spendingId, -command.amount], [heldId, command.amount]],
      });
      await transaction`
        INSERT INTO job_status_history (job_id, from_status, to_status, actor_user_id, source, reason)
        VALUES (${jobId}, NULL, 'OPEN', ${command.userId}, 'USER', 'Funded job published')
      `;
      await transaction`
        INSERT INTO wallet_activities (
          user_id, type, status, spending_delta_baht, job_held_delta_baht,
          resource_type, resource_id
        ) VALUES (
          ${command.userId}, 'JOB_FUNDING', 'SUCCEEDED', ${-command.amount},
          ${command.amount}, 'JOB', ${jobId}
        )
      `;
      const response = await this.jobById(transaction, jobId);
      await this.completeIdempotency(transaction, claimed.id, 'JOB', jobId, 201, response);
      return response;
    });
  }

  async cancelJob(command: JobCommand): Promise<FundedJob> {
    return this.database.begin(async (transaction) => {
      const claimed = await this.claimIdempotency(transaction, command, 'JOB_CANCEL');
      if (claimed.replay) return storedJob(claimed.replay);
      const job = await this.lockJob(transaction, command.jobId);
      if (job.employer_user_id !== command.userId) {
        throw new JobError(403, 'FORBIDDEN', 'Only the job employer can cancel this job.');
      }
      if (job.status !== 'OPEN' || job.selected_worker_user_id) {
        throw new JobError(409, 'JOB_NOT_CANCELLABLE', 'The job can no longer be cancelled by its employer.');
      }
      const amount = safeInteger(job.amount_baht, 'amount_baht');
      const [wallet] = await transaction`
        SELECT id::text FROM wallets WHERE user_id = ${command.userId} FOR UPDATE
      `;
      if (!wallet) throw new Error('Employer wallet is not provisioned.');
      const accounts = (await transaction`
        SELECT id::text, type FROM ledger_accounts
        WHERE wallet_id = ${wallet.id} AND type IN ('SPENDING', 'JOB_HELD')
        ORDER BY type
      `) as unknown as Array<{ id: string; type: 'SPENDING' | 'JOB_HELD' }>;
      const spendingId = accounts.find((account) => account.type === 'SPENDING')?.id;
      const heldId = accounts.find((account) => account.type === 'JOB_HELD')?.id;
      if (!spendingId || !heldId) throw new Error('Employer ledger accounts are not provisioned.');
      await this.postLedger(transaction, {
        transactionId: crypto.randomUUID(),
        businessReference: `job-return:${job.id}`,
        eventType: 'JOB_RETURN',
        idempotencyId: claimed.id,
        userId: command.userId,
        description: 'Cancelled job funding returned',
        postings: [[heldId, -amount], [spendingId, amount]],
      });
      await transaction`
        UPDATE jobs SET status = 'CANCELLED', updated_at = now() WHERE id = ${job.id}
      `;
      await transaction`
        INSERT INTO job_status_history (job_id, from_status, to_status, actor_user_id, source, reason)
        VALUES (${job.id}, 'OPEN', 'CANCELLED', ${command.userId}, 'USER', 'Employer cancelled before selection')
      `;
      await transaction`
        INSERT INTO wallet_activities (
          user_id, type, status, spending_delta_baht, job_held_delta_baht,
          resource_type, resource_id
        ) VALUES (${command.userId}, 'JOB_RETURN', 'SUCCEEDED', ${amount}, ${-amount}, 'JOB', ${job.id})
      `;
      const response = await this.jobById(transaction, job.id);
      await this.completeIdempotency(transaction, claimed.id, 'JOB', job.id, 200, response);
      return response;
    });
  }

  async createApplication(command: CreateApplicationCommand): Promise<JobApplication> {
    return this.database.begin(async (transaction) => {
      const claimed = await this.claimIdempotency(transaction, command, 'JOB_APPLICATION_CREATE');
      if (claimed.replay) return storedApplication(claimed.replay);
      const job = await this.lockJob(transaction, command.jobId);
      if (job.employer_user_id === command.userId) {
        throw new JobError(409, 'EMPLOYER_CANNOT_APPLY', 'An employer cannot apply to their own job.');
      }
      if (job.status !== 'OPEN' || new Date(job.application_deadline_at) <= new Date()) {
        throw new JobError(409, 'JOB_NOT_OPEN', 'The job is not accepting applications.');
      }
      const [wallet] = await transaction`
        SELECT id::text, status FROM wallets WHERE user_id = ${command.userId} FOR UPDATE
      `;
      if (!wallet) throw new Error('Worker wallet is not provisioned.');
      if (wallet.status === 'FROZEN') throw new JobError(423, 'WALLET_FROZEN', 'The wallet is frozen.');
      const [engagement] = await transaction`
        SELECT id::text FROM jobs
        WHERE selected_worker_user_id = ${command.userId}
          AND status IN ('ASSIGNED','OVERDUE','IN_REVIEW','DISPUTED')
        LIMIT 1
      `;
      if (engagement) throw new JobError(409, 'WORKER_ENGAGED', 'The worker already has an active job.');
      const [existing] = await transaction`
        SELECT id::text FROM job_applications
        WHERE job_id = ${job.id} AND worker_user_id = ${command.userId}
      `;
      if (existing) throw new JobError(409, 'APPLICATION_EXISTS', 'The worker already applied to this job.');
      const message = command.message.trim();
      if (!message) throw new JobError(422, 'VALIDATION_FAILED', 'Application message cannot be blank.');
      const applicationId = crypto.randomUUID();
      await transaction`
        INSERT INTO job_applications (id, job_id, worker_user_id, message, status)
        VALUES (${applicationId}, ${job.id}, ${command.userId}, ${message}, 'PENDING')
      `;
      await transaction`
        INSERT INTO job_application_status_history (
          application_id, from_status, to_status, actor_user_id, source, reason
        ) VALUES (${applicationId}, NULL, 'PENDING', ${command.userId}, 'USER', 'Worker applied')
      `;
      const response = await this.applicationById(transaction, applicationId);
      await this.completeIdempotency(transaction, claimed.id, 'JOB_APPLICATION', applicationId, 201, response);
      return response;
    });
  }

  async listApplications(
    userId: string,
    jobId: string,
    query: PageQuery,
  ): Promise<JobApplicationPage> {
    const offset = parseOffset(query.cursor);
    const [job] = await this.database`
      SELECT employer_user_id FROM jobs WHERE id = ${jobId}
    `;
    if (!job) throw new JobError(404, 'JOB_NOT_FOUND', 'The job was not found.');
    if (job.employer_user_id !== userId) {
      throw new JobError(403, 'FORBIDDEN', 'Only the job employer can list applications.');
    }
    const rows = (await this.database`
      SELECT id::text, job_id::text, worker_user_id, message, status, created_at, updated_at
      FROM job_applications WHERE job_id = ${jobId}
      ORDER BY created_at ASC, id ASC LIMIT ${query.limit + 1} OFFSET ${offset}
    `) as unknown as ApplicationRow[];
    return {
      items: rows.slice(0, query.limit).map(application),
      next_cursor: rows.length > query.limit ? String(offset + query.limit) : null,
    };
  }

  async getMyApplication(userId: string, jobId: string): Promise<JobApplication | null> {
    const [row] = (await this.database`
      SELECT id::text, job_id::text, worker_user_id, message, status, created_at, updated_at
      FROM job_applications WHERE job_id=${jobId} AND worker_user_id=${userId}
    `) as unknown as ApplicationRow[];
    return row ? application(row) : null;
  }

  async getSubmission(userId: string, jobId: string): Promise<WorkSubmission | null> {
    const [row] = (await this.database`
      SELECT submission.id::text, submission.job_id::text, submission.worker_user_id,
        submission.status, submission.summary, submission.review_deadline_at, submission.created_at
      FROM work_submissions submission JOIN jobs job ON job.id=submission.job_id
      WHERE submission.job_id=${jobId}
        AND (job.employer_user_id=${userId} OR submission.worker_user_id=${userId})
    `) as unknown as Array<{id:string;job_id:string;worker_user_id:string;status:WorkSubmission['status'];
      summary:string;review_deadline_at:Date|string;created_at:Date|string}>;
    return row ? {id:row.id,job_id:row.job_id,worker_user_id:row.worker_user_id,status:row.status,
      summary:row.summary,review_deadline:iso(row.review_deadline_at),created_at:iso(row.created_at)} : null;
  }

  async selectWorker(command: SelectWorkerCommand): Promise<FundedJob> {
    return this.database.begin(async (transaction) => {
      const claimed = await this.claimIdempotency(transaction, command, 'JOB_WORKER_SELECTION');
      if (claimed.replay) return storedJob(claimed.replay);
      const job = await this.lockJob(transaction, command.jobId);
      if (job.employer_user_id !== command.userId) {
        throw new JobError(403, 'FORBIDDEN', 'Only the job employer can select a worker.');
      }
      if (job.status !== 'OPEN' || new Date(job.application_deadline_at) <= new Date()) {
        throw new JobError(409, 'JOB_NOT_OPEN', 'The job is no longer open for selection.');
      }
      const [selected] = (await transaction`
        SELECT id::text, job_id::text, worker_user_id, message, status, created_at, updated_at
        FROM job_applications WHERE id = ${command.applicationId} FOR UPDATE
      `) as unknown as ApplicationRow[];
      if (!selected || selected.job_id !== job.id) {
        throw new JobError(404, 'APPLICATION_NOT_FOUND', 'The application was not found for this job.');
      }
      if (selected.status !== 'PENDING') {
        throw new JobError(409, 'APPLICATION_NOT_PENDING', 'The application is no longer pending.');
      }
      const [workerWallet] = await transaction`
        SELECT id::text, status FROM wallets WHERE user_id = ${selected.worker_user_id} FOR UPDATE
      `;
      if (!workerWallet) throw new Error('Worker wallet is not provisioned.');
      if (workerWallet.status === 'FROZEN') throw new JobError(423, 'WALLET_FROZEN', 'The worker wallet is frozen.');
      const [engagement] = await transaction`
        SELECT id::text FROM jobs
        WHERE selected_worker_user_id = ${selected.worker_user_id}
          AND status IN ('ASSIGNED','OVERDUE','IN_REVIEW','DISPUTED')
        LIMIT 1
      `;
      if (engagement) throw new JobError(409, 'WORKER_ENGAGED', 'The worker already has an active job.');

      await transaction`
        UPDATE jobs SET selected_worker_user_id = ${selected.worker_user_id},
          status = 'ASSIGNED', assigned_at = now(), updated_at = now()
        WHERE id = ${job.id}
      `;
      await transaction`
        UPDATE job_applications SET status = 'SELECTED', updated_at = now()
        WHERE id = ${selected.id}
      `;
      await transaction`
        INSERT INTO job_application_status_history (
          application_id, from_status, to_status, actor_user_id, source, reason
        ) VALUES (${selected.id}, 'PENDING', 'SELECTED', ${command.userId}, 'USER', 'Employer selected worker')
      `;
      await transaction`
        WITH changed AS (
          UPDATE job_applications SET status = 'REJECTED', updated_at = now()
          WHERE job_id = ${job.id} AND id <> ${selected.id} AND status = 'PENDING'
          RETURNING id
        )
        INSERT INTO job_application_status_history (
          application_id, from_status, to_status, actor_user_id, source, reason
        ) SELECT id, 'PENDING', 'REJECTED', ${command.userId}, 'SYSTEM', 'Another applicant was selected'
          FROM changed
      `;
      await transaction`
        WITH changed AS (
          UPDATE job_applications SET status = 'REMOVED_WORKER_ENGAGED', updated_at = now()
          WHERE worker_user_id = ${selected.worker_user_id}
            AND job_id <> ${job.id} AND status = 'PENDING'
          RETURNING id
        )
        INSERT INTO job_application_status_history (
          application_id, from_status, to_status, actor_user_id, source, reason
        ) SELECT id, 'PENDING', 'REMOVED_WORKER_ENGAGED', ${command.userId}, 'SYSTEM', 'Worker became engaged'
          FROM changed
      `;
      await transaction`
        INSERT INTO job_status_history (job_id, from_status, to_status, actor_user_id, source, reason)
        VALUES (${job.id}, 'OPEN', 'ASSIGNED', ${command.userId}, 'USER', 'Employer selected worker')
      `;
      const response = await this.jobById(transaction, job.id);
      await this.completeIdempotency(transaction, claimed.id, 'JOB', job.id, 200, response);
      return response;
    });
  }

  async submitWork(command: SubmitWorkCommand): Promise<FundedJob> {
    return this.database.begin(async (transaction) => {
      const claimed = await this.claimIdempotency(transaction, command, 'JOB_WORK_SUBMISSION');
      if (claimed.replay) return storedJob(claimed.replay);
      const job = await this.lockJob(transaction, command.jobId);
      if (job.selected_worker_user_id !== command.userId) {
        throw new JobError(403, 'FORBIDDEN', 'Only the selected worker can submit work.');
      }
      if (job.status !== 'ASSIGNED' && job.status !== 'OVERDUE') {
        throw new JobError(409, 'JOB_NOT_SUBMITTABLE', 'The job is not awaiting worker submission.');
      }
      const summary = command.summary.trim();
      if (!summary) throw new JobError(422, 'VALIDATION_FAILED', 'Work summary cannot be blank.');
      const [policy] = await transaction`
        SELECT review_window_seconds::text FROM money_policy_revisions
        WHERE id = ${job.policy_revision_id}
      `;
      if (!policy) throw new Error('The job policy snapshot is missing.');
      const reviewSeconds = safeInteger(policy.review_window_seconds, 'review_window_seconds');
      const submissionId = crypto.randomUUID();
      await transaction`
        INSERT INTO work_submissions (
          id, job_id, worker_user_id, summary, status, review_deadline_at
        ) VALUES (
          ${submissionId}, ${job.id}, ${command.userId}, ${summary}, 'SUBMITTED',
          now() + (${reviewSeconds} * interval '1 second')
        )
      `;
      await transaction`
        INSERT INTO work_submission_status_history (
          submission_id, from_status, to_status, actor_user_id, source, reason
        ) VALUES (${submissionId}, NULL, 'SUBMITTED', ${command.userId}, 'USER', 'Worker submitted work')
      `;
      await transaction`
        UPDATE jobs SET status = 'IN_REVIEW', updated_at = now() WHERE id = ${job.id}
      `;
      await transaction`
        INSERT INTO job_status_history (job_id, from_status, to_status, actor_user_id, source, reason)
        VALUES (${job.id}, ${job.status}, 'IN_REVIEW', ${command.userId}, 'USER', 'Worker submitted work')
      `;
      const response = await this.jobById(transaction, job.id);
      await this.completeIdempotency(transaction, claimed.id, 'JOB', job.id, 200, response);
      return response;
    });
  }

  async approveWork(command: JobCommand): Promise<FundedJob> {
    return this.database.begin(async (transaction) => {
      const claimed = await this.claimIdempotency(transaction, command, 'JOB_APPROVAL');
      if (claimed.replay) return storedJob(claimed.replay);
      const job = await this.lockJob(transaction, command.jobId);
      if (job.employer_user_id !== command.userId) {
        throw new JobError(403, 'FORBIDDEN', 'Only the job employer can approve the work.');
      }
      if (job.status !== 'IN_REVIEW' || !job.selected_worker_user_id) {
        throw new JobError(409, 'JOB_NOT_APPROVABLE', 'The job is not awaiting employer approval.');
      }
      const wallets = (await transaction`
        SELECT id::text, user_id FROM wallets
        WHERE user_id IN (${job.employer_user_id}, ${job.selected_worker_user_id})
        ORDER BY user_id FOR UPDATE
      `) as unknown as Array<{ id: string; user_id: string }>;
      const employerWalletId = wallets.find((wallet) => wallet.user_id === job.employer_user_id)?.id;
      const workerWalletId = wallets.find((wallet) => wallet.user_id === job.selected_worker_user_id)?.id;
      if (!employerWalletId || !workerWalletId) throw new Error('Job party wallets are not provisioned.');
      const accounts = (await transaction`
        SELECT id::text, wallet_id::text, type, code FROM ledger_accounts
        WHERE (wallet_id = ${employerWalletId} AND type = 'JOB_HELD')
           OR (wallet_id = ${workerWalletId} AND type = 'EARNINGS')
           OR code = 'SYSTEM:PLATFORM_REVENUE'
        ORDER BY code
      `) as unknown as Array<{ id: string; wallet_id: string | null; type: string; code: string }>;
      const heldId = accounts.find((account) => account.wallet_id === employerWalletId && account.type === 'JOB_HELD')?.id;
      const earningsId = accounts.find((account) => account.wallet_id === workerWalletId && account.type === 'EARNINGS')?.id;
      const revenueId = accounts.find((account) => account.code === 'SYSTEM:PLATFORM_REVENUE')?.id;
      if (!heldId || !earningsId || !revenueId) throw new Error('Settlement ledger accounts are not provisioned.');
      const amount = safeInteger(job.amount_baht, 'amount_baht');
      const workerNet = safeInteger(job.worker_net_baht, 'worker_net_baht');
      const fee = safeInteger(job.platform_fee_baht, 'platform_fee_baht');
      await this.postLedger(transaction, {
        transactionId: crypto.randomUUID(),
        businessReference: `job-settlement:${job.id}`,
        eventType: 'JOB_SETTLEMENT',
        idempotencyId: claimed.id,
        userId: command.userId,
        description: 'Employer approved work and settled job',
        postings: [[heldId, -amount], [earningsId, workerNet], [revenueId, fee]],
      });
      await transaction`
        UPDATE jobs SET status = 'SETTLED', completed_at = now(), updated_at = now()
        WHERE id = ${job.id}
      `;
      await transaction`
        WITH changed AS (
          UPDATE work_submissions SET status = 'APPROVED'
          WHERE job_id = ${job.id} AND status = 'SUBMITTED'
          RETURNING id
        )
        INSERT INTO work_submission_status_history (
          submission_id, from_status, to_status, actor_user_id, source, reason
        ) SELECT id, 'SUBMITTED', 'APPROVED', ${command.userId}, 'USER', 'Employer approved work'
          FROM changed
      `;
      await transaction`
        INSERT INTO job_status_history (job_id, from_status, to_status, actor_user_id, source, reason)
        VALUES (${job.id}, 'IN_REVIEW', 'SETTLED', ${command.userId}, 'USER', 'Employer approved work')
      `;
      await transaction`
        INSERT INTO wallet_activities (
          user_id, type, status, job_held_delta_baht, resource_type, resource_id
        ) VALUES (${job.employer_user_id}, 'JOB_SETTLEMENT', 'SUCCEEDED', ${-amount}, 'JOB', ${job.id})
      `;
      await transaction`
        INSERT INTO wallet_activities (
          user_id, type, status, earnings_delta_baht, resource_type, resource_id
        ) VALUES (${job.selected_worker_user_id}, 'JOB_SETTLEMENT', 'SUCCEEDED', ${workerNet}, 'JOB', ${job.id})
      `;
      const response = await this.jobById(transaction, job.id);
      await this.completeIdempotency(transaction, claimed.id, 'JOB', job.id, 200, response);
      return response;
    });
  }

  private async claimIdempotency(
    transaction: TransactionSql,
    command: { userId: string; idempotencyKey: string; requestHash: string },
    scope: string,
  ): Promise<{ id: string; replay: unknown }> {
    const id = crypto.randomUUID();
    const inserted = await transaction`
      INSERT INTO idempotency_keys (
        id, principal_user_id, operation_scope, key, request_hash, expires_at
      ) VALUES (
        ${id}, ${command.userId}, ${scope}, ${command.idempotencyKey},
        ${command.requestHash}, now() + interval '24 hours'
      ) ON CONFLICT DO NOTHING RETURNING id
    `;
    if (inserted.length > 0) return { id, replay: null };
    const [existing] = (await transaction`
      SELECT id::text, request_hash, response_body FROM idempotency_keys
      WHERE principal_user_id = ${command.userId}
        AND operation_scope = ${scope} AND key = ${command.idempotencyKey}
      FOR UPDATE
    `) as unknown as Array<IdempotencyRow & { id: string }>;
    if (!existing || existing.request_hash !== command.requestHash) {
      throw new JobError(409, 'IDEMPOTENCY_CONFLICT', 'The idempotency key was already used with a different request.');
    }
    if (!existing.response_body) throw new Error('An idempotent operation did not store its response.');
    return { id: existing.id, replay: existing.response_body };
  }

  private async completeIdempotency(
    transaction: TransactionSql,
    id: string,
    resourceType: string,
    resourceId: string,
    status: number,
    response: unknown,
  ): Promise<void> {
    await transaction`
      UPDATE idempotency_keys SET resource_type = ${resourceType}, resource_id = ${resourceId},
        response_status = ${status}, response_body = ${JSON.stringify(response)}::text::jsonb
      WHERE id = ${id}
    `;
  }

  private async lockJob(transaction: TransactionSql, jobId: string): Promise<JobRow> {
    const [row] = (await transaction`
      SELECT job.id::text, job.employer_user_id, job.selected_worker_user_id,
             job.title, job.description, job.amount_baht::text,
             job.platform_fee_bps::text, job.platform_fee_baht::text,
             job.worker_net_baht::text, job.policy_revision_id::text, job.status,
             job.application_deadline_at, job.work_deadline_at,
             NULL::timestamptz AS review_deadline_at, job.created_at, job.updated_at
      FROM jobs job WHERE job.id = ${jobId} FOR UPDATE
    `) as unknown as JobRow[];
    if (!row) throw new JobError(404, 'JOB_NOT_FOUND', 'The job was not found.');
    return row;
  }

  private async jobById(transaction: TransactionSql, jobId: string): Promise<FundedJob> {
    const [row] = (await transaction.unsafe(
      `${jobSelect} WHERE job.id = $1`,
      [jobId],
    )) as unknown as JobRow[];
    if (!row) throw new Error('Job write did not produce a readable job.');
    return fundedJob(row);
  }

  private async applicationById(
    transaction: TransactionSql,
    applicationId: string,
  ): Promise<JobApplication> {
    const [row] = (await transaction`
      SELECT id::text, job_id::text, worker_user_id, message, status, created_at, updated_at
      FROM job_applications WHERE id = ${applicationId}
    `) as unknown as ApplicationRow[];
    if (!row) throw new Error('Application write did not produce a readable application.');
    return application(row);
  }

  private async postLedger(
    transaction: TransactionSql,
    args: {
      transactionId: string;
      businessReference: string;
      eventType: string;
      idempotencyId: string;
      userId: string;
      description: string;
      postings: Array<[string, number]>;
    },
  ): Promise<void> {
    const postings = args.postings.filter(([, amount]) => amount !== 0);
    if (postings.length < 2 || postings.reduce((sum, posting) => sum + posting[1], 0) !== 0) {
      throw new Error('Ledger postings must be balanced before persistence.');
    }
    await transaction`
      INSERT INTO ledger_transactions (
        id, business_reference, event_type, idempotency_key_id,
        created_by_user_id, description
      ) VALUES (
        ${args.transactionId}, ${args.businessReference}, ${args.eventType},
        ${args.idempotencyId}, ${args.userId}, ${args.description}
      )
    `;
    await Promise.all(
      postings.map(([accountId, amount]) => transaction`
        INSERT INTO ledger_postings (transaction_id, account_id, amount_baht)
        VALUES (${args.transactionId}, ${accountId}, ${amount})
      `),
    );
    await transaction`
      UPDATE ledger_transactions SET sealed_at = now() WHERE id = ${args.transactionId}
    `;
  }
}
