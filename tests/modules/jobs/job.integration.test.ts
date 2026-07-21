import { beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';

import { createJobRoute } from '@/modules/jobs/job.route';
import type {
  CreateApplicationCommand,
  CreateFundedJobCommand,
  FundedJob,
  JobApplication,
  JobApplicationPage,
  JobCommand,
  JobPage,
  JobRepository,
  ListJobsQuery,
  PageQuery,
  SelectWorkerCommand,
  SubmitWorkCommand,
  WorkSubmission,
} from '@/modules/jobs/job.types';
import { errorHandlerPlugin } from '@/plugins/error-handler';

const job: FundedJob = {
  id: '00000000-0000-4000-8000-000000000001',
  employer_user_id: 'employer-1',
  intended_payee_user_id: null,
  title: 'Translate a short document',
  description: 'Translate the supplied document into Thai.',
  status: 'OPEN',
  job_amount: 1_000,
  platform_fee_rate_bps: 200,
  platform_fee_amount: 20,
  worker_net_amount: 980,
  currency: 'THB',
  application_deadline: '2026-07-15T10:00:00.000Z',
  work_deadline: '2026-07-16T10:00:00.000Z',
  review_deadline: null,
  created_at: '2026-07-14T10:00:00.000Z',
  updated_at: '2026-07-14T10:00:00.000Z',
};

const application: JobApplication = {
  id: '00000000-0000-4000-8000-000000000002',
  job_id: job.id,
  worker_user_id: 'worker-1',
  status: 'PENDING',
  message: 'I can complete this work.',
  created_at: '2026-07-14T10:05:00.000Z',
  updated_at: '2026-07-14T10:05:00.000Z',
};

class RouteRepository implements JobRepository {
  lastCreate: CreateFundedJobCommand | null = null;
  lastApplication: CreateApplicationCommand | null = null;

  async listJobs(_userId: string, _query: ListJobsQuery): Promise<JobPage> {
    return { items: [job], next_cursor: null };
  }

  async getJob(): Promise<FundedJob> {
    return job;
  }

  async createFundedJob(command: CreateFundedJobCommand): Promise<FundedJob> {
    this.lastCreate = command;
    return job;
  }

  async cancelJob(_command: JobCommand): Promise<FundedJob> {
    return { ...job, status: 'CANCELLED' };
  }

  async createApplication(command: CreateApplicationCommand): Promise<JobApplication> {
    this.lastApplication = command;
    return application;
  }

  async listApplications(
    _userId: string,
    _jobId: string,
    _query: PageQuery,
  ): Promise<JobApplicationPage> {
    return { items: [application], next_cursor: null };
  }

  async getMyApplication(): Promise<JobApplication | null> { return application; }

  async getSubmission(): Promise<WorkSubmission | null> { return null; }

  async selectWorker(_command: SelectWorkerCommand): Promise<FundedJob> {
    return { ...job, status: 'ASSIGNED', intended_payee_user_id: 'worker-1' };
  }

  async submitWork(_command: SubmitWorkCommand): Promise<FundedJob> {
    return {
      ...job,
      status: 'IN_REVIEW',
      intended_payee_user_id: 'worker-1',
      review_deadline: '2026-07-17T10:00:00.000Z',
    };
  }

  async approveWork(_command: JobCommand): Promise<FundedJob> {
    return { ...job, status: 'SETTLED', intended_payee_user_id: 'worker-1' };
  }
}

const request = (
  path: string,
  options: { method?: string; body?: unknown; key?: string; origin?: string } = {},
) => {
  const headers = new Headers({
    'content-type': 'application/json',
    origin: options.origin ?? 'http://localhost:3000',
  });
  if (options.key) headers.set('idempotency-key', options.key);
  return new Request(`http://localhost${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
};

const makeApp = (routeRepository: RouteRepository) => new Elysia()
  .use(errorHandlerPlugin)
  .use(
    createJobRoute(
      routeRepository,
      async () => ({ user: { id: 'employer-1' } }),
      ['http://localhost:3000'],
    ),
  );

describe('funded job HTTP contract', () => {
  let repository: RouteRepository;
  let app: ReturnType<typeof makeApp>;

  beforeEach(() => {
    repository = new RouteRepository();
    app = makeApp(repository);
  });

  it('returns refresh-safe job list and detail envelopes', async () => {
    const list = await app.handle(request('/v1/jobs?scope=mine'));
    const listBody = await list.json();
    expect(list.status).toBe(200);
    expect(listBody).toMatchObject({ success: true, error: null });
    expect(listBody.data.items[0].title).toBe(job.title);
    expect(listBody.trace_id).toEqual(expect.any(String));

    const detail = await app.handle(request(`/v1/jobs/${job.id}`));
    expect(detail.status).toBe(200);
    expect((await detail.json()).data.id).toBe(job.id);
  });

  it('authenticates, checks CSRF, validates, and forwards idempotent funding', async () => {
    const body = {
      title: job.title,
      description: job.description,
      job_amount: 1_000,
      application_deadline: job.application_deadline,
      work_deadline: job.work_deadline,
    };
    const response = await app.handle(
      request('/v1/jobs', {
        method: 'POST',
        key: 'create-funded-job-0001',
        body,
      }),
    );
    expect(response.status).toBe(201);
    expect((await response.json()).data.job_amount).toBe(1_000);
    expect(repository.lastCreate).toMatchObject({
      userId: 'employer-1',
      idempotencyKey: 'create-funded-job-0001',
      amount: 1_000,
    });
    expect(repository.lastCreate?.requestHash).toEqual(expect.any(String));

    const crossSite = await app.handle(
      request('/v1/jobs', {
        method: 'POST',
        key: 'create-funded-job-0002',
        origin: 'https://attacker.example',
        body,
      }),
    );
    expect(crossSite.status).toBe(403);
    expect((await crossSite.json()).error.code).toBe('FORBIDDEN');

    const invalid = await app.handle(
      request('/v1/jobs', {
        method: 'POST',
        key: 'create-funded-job-0003',
        body: { ...body, job_amount: 1.5 },
      }),
    );
    expect(invalid.status).toBe(422);
    expect((await invalid.json()).error.code).toBe('VALIDATION_FAILED');
  });

  it('exposes applications and every happy-path transition', async () => {
    const createApplication = await app.handle(
      request(`/v1/jobs/${job.id}/applications`, {
        method: 'POST',
        key: 'create-application-0001',
        body: { message: application.message },
      }),
    );
    expect(createApplication.status).toBe(201);
    expect((await createApplication.json()).data.id).toBe(application.id);

    const list = await app.handle(request(`/v1/jobs/${job.id}/applications`));
    expect(list.status).toBe(200);
    expect((await list.json()).data.items).toHaveLength(1);

    const selection = await app.handle(
      request(`/v1/jobs/${job.id}/worker-selection`, {
        method: 'POST',
        key: 'select-worker-00001',
        body: { application_id: application.id },
      }),
    );
    expect(selection.status).toBe(200);
    expect((await selection.json()).data).toMatchObject({
      status: 'ASSIGNED',
      intended_payee_user_id: 'worker-1',
    });

    const submission = await app.handle(
      request(`/v1/jobs/${job.id}/work-submission`, {
        method: 'POST',
        key: 'submit-work-0000001',
        body: { summary: 'Work completed.' },
      }),
    );
    expect(submission.status).toBe(200);
    expect((await submission.json()).data.status).toBe('IN_REVIEW');

    const approval = await app.handle(
      request(`/v1/jobs/${job.id}/approval`, {
        method: 'POST',
        key: 'approve-work-000001',
      }),
    );
    expect(approval.status).toBe(200);
    expect((await approval.json()).data.status).toBe('SETTLED');
  });

  it('rejects reads without a session', async () => {
    const anonymous = new Elysia()
      .use(errorHandlerPlugin)
      .use(createJobRoute(repository, async () => null, ['http://localhost:3000']));
    const response = await anonymous.handle(request('/v1/jobs'));
    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe('UNAUTHORIZED');
  });
});
