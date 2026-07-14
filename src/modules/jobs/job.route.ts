import { Elysia, t } from 'elysia';

import {
  apiFailureSchema,
  apiSuccess,
  apiSuccessSchema,
} from '@/http/api-response';
import {
  assertTrustedBrowserOrigin,
  type SessionResolver,
} from '@/modules/auth';
import { sha256, stableJson } from '@/modules/money/money.crypto';

import { JobError } from './job.errors';
import {
  fundedJobSchema,
  idempotencyHeadersSchema,
  jobApplicationPageSchema,
  jobApplicationSchema,
  jobIdParamsSchema,
  jobPageSchema,
  jobStatusSchema,
  workSubmissionSchema,
} from './job.schema';
import type { JobRepository } from './job.types';

const currentUserId = async (
  headers: Headers,
  resolveSession: SessionResolver,
): Promise<string> => {
  const session = await resolveSession(headers);
  if (!session?.user.id) {
    throw new JobError(401, 'UNAUTHORIZED', 'A valid session is required.');
  }
  return session.user.id;
};

const commandIdentity = async (
  request: Request,
  resolveSession: SessionResolver,
  trustedOrigins: readonly string[],
  idempotencyKey: string,
  payload: unknown,
) => {
  const userId = await currentUserId(request.headers, resolveSession);
  assertTrustedBrowserOrigin(request.headers, trustedOrigins);
  return {
    userId,
    idempotencyKey,
    requestHash: await sha256(stableJson(payload)),
  };
};

const commandResponses = {
  200: apiSuccessSchema(fundedJobSchema),
  401: apiFailureSchema,
  403: apiFailureSchema,
  404: apiFailureSchema,
  409: apiFailureSchema,
  422: apiFailureSchema,
  423: apiFailureSchema,
};

export const createJobRoute = (
  repository: JobRepository,
  resolveSession: SessionResolver,
  trustedOrigins: readonly string[],
) =>
  new Elysia({ name: 'job-route', prefix: '/v1/jobs' })
    .get(
      '',
      async ({ query, request }) => {
        const userId = await currentUserId(request.headers, resolveSession);
        return apiSuccess(
          await repository.listJobs(userId, {
            scope: query.scope ?? 'marketplace',
            status: query.status,
            cursor: query.cursor,
            limit: query.limit ?? 20,
          }),
          request,
        );
      },
      {
        query: t.Object({
          scope: t.Optional(
            t.Union([
              t.Literal('marketplace'),
              t.Literal('mine'),
              t.Literal('assigned'),
            ]),
          ),
          status: t.Optional(jobStatusSchema),
          cursor: t.Optional(t.String()),
          limit: t.Optional(t.Integer({ minimum: 1, maximum: 100, default: 20 })),
        }),
        response: {
          200: apiSuccessSchema(jobPageSchema),
          401: apiFailureSchema,
          422: apiFailureSchema,
        },
        detail: {
          tags: ['Funded jobs'],
          summary: 'List marketplace or participant-visible funded jobs',
          operationId: 'listFundedJobs',
          security: [{ betterAuthSession: [] }],
        },
      },
    )
    .get(
      '/:job_id',
      async ({ params, request }) =>
        apiSuccess(
          await repository.getJob(
            await currentUserId(request.headers, resolveSession),
            params.job_id,
          ),
          request,
        ),
      {
        params: jobIdParamsSchema,
        response: {
          200: apiSuccessSchema(fundedJobSchema),
          401: apiFailureSchema,
          403: apiFailureSchema,
          404: apiFailureSchema,
        },
        detail: {
          tags: ['Funded jobs'],
          summary: 'Get a visible funded job',
          operationId: 'getFundedJob',
          security: [{ betterAuthSession: [] }],
        },
      },
    )
    .post(
      '',
      async ({ body, headers, request, status }) => {
        const identity = await commandIdentity(
          request,
          resolveSession,
          trustedOrigins,
          headers['idempotency-key'],
          body,
        );
        const job = await repository.createFundedJob({
          ...identity,
          title: body.title,
          description: body.description,
          amount: body.job_amount,
          applicationDeadline: body.application_deadline,
          workDeadline: body.work_deadline,
        });
        return status(201, apiSuccess(job, request));
      },
      {
        body: t.Object({
          title: t.String({ minLength: 1, maxLength: 200 }),
          description: t.String({ minLength: 1, maxLength: 10_000 }),
          job_amount: t.Integer({ minimum: 1 }),
          application_deadline: t.String({ format: 'date-time' }),
          work_deadline: t.String({ format: 'date-time' }),
        }),
        headers: idempotencyHeadersSchema,
        response: { ...commandResponses, 201: apiSuccessSchema(fundedJobSchema) },
        detail: {
          tags: ['Funded jobs'],
          summary: 'Publish and fund a job atomically',
          operationId: 'createFundedJob',
          security: [{ betterAuthSession: [] }],
        },
      },
    )
    .post(
      '/:job_id/cancellation',
      async ({ headers, params, request }) => {
        const identity = await commandIdentity(
          request,
          resolveSession,
          trustedOrigins,
          headers['idempotency-key'],
          { job_id: params.job_id },
        );
        return apiSuccess(
          await repository.cancelJob({ ...identity, jobId: params.job_id }),
          request,
        );
      },
      {
        params: jobIdParamsSchema,
        headers: idempotencyHeadersSchema,
        response: commandResponses,
        detail: {
          tags: ['Funded jobs'],
          summary: 'Cancel an unassigned funded job and return held value',
          operationId: 'cancelFundedJob',
          security: [{ betterAuthSession: [] }],
        },
      },
    )
    .get(
      '/:job_id/applications',
      async ({ params, query, request }) =>
        apiSuccess(
          await repository.listApplications(
            await currentUserId(request.headers, resolveSession),
            params.job_id,
            { cursor: query.cursor, limit: query.limit ?? 20 },
          ),
          request,
        ),
      {
        params: jobIdParamsSchema,
        query: t.Object({
          cursor: t.Optional(t.String()),
          limit: t.Optional(t.Integer({ minimum: 1, maximum: 100, default: 20 })),
        }),
        response: {
          200: apiSuccessSchema(jobApplicationPageSchema),
          401: apiFailureSchema,
          403: apiFailureSchema,
          404: apiFailureSchema,
          422: apiFailureSchema,
        },
        detail: {
          tags: ['Funded jobs'],
          summary: 'List applications for the job employer',
          operationId: 'listJobApplications',
          security: [{ betterAuthSession: [] }],
        },
      },
    )
    .get(
      '/:job_id/my-application',
      async ({params,request}) => apiSuccess(
        await repository.getMyApplication(await currentUserId(request.headers,resolveSession),params.job_id),request),
      {params:jobIdParamsSchema,response:{200:apiSuccessSchema(t.Nullable(jobApplicationSchema)),401:apiFailureSchema},
        detail:{tags:['Funded jobs'],summary:"Get the current worker's application state",security:[{betterAuthSession:[]}]}}
    )
    .get(
      '/:job_id/work-submission',
      async ({params,request}) => apiSuccess(
        await repository.getSubmission(await currentUserId(request.headers,resolveSession),params.job_id),request),
      {params:jobIdParamsSchema,response:{200:apiSuccessSchema(t.Nullable(workSubmissionSchema)),401:apiFailureSchema},
        detail:{tags:['Funded jobs'],summary:'Get the participant-visible work submission',security:[{betterAuthSession:[]}]}}
    )
    .post(
      '/:job_id/applications',
      async ({ body, headers, params, request, status }) => {
        const identity = await commandIdentity(
          request,
          resolveSession,
          trustedOrigins,
          headers['idempotency-key'],
          { job_id: params.job_id, ...body },
        );
        const application = await repository.createApplication({
          ...identity,
          jobId: params.job_id,
          message: body.message,
        });
        return status(201, apiSuccess(application, request));
      },
      {
        params: jobIdParamsSchema,
        body: t.Object({ message: t.String({ minLength: 1, maxLength: 2_000 }) }),
        headers: idempotencyHeadersSchema,
        response: {
          201: apiSuccessSchema(jobApplicationSchema),
          401: apiFailureSchema,
          403: apiFailureSchema,
          404: apiFailureSchema,
          409: apiFailureSchema,
          422: apiFailureSchema,
          423: apiFailureSchema,
        },
        detail: {
          tags: ['Funded jobs'],
          summary: 'Apply to an open funded job',
          operationId: 'applyToJob',
          security: [{ betterAuthSession: [] }],
        },
      },
    )
    .post(
      '/:job_id/worker-selection',
      async ({ body, headers, params, request }) => {
        const identity = await commandIdentity(
          request,
          resolveSession,
          trustedOrigins,
          headers['idempotency-key'],
          { job_id: params.job_id, ...body },
        );
        return apiSuccess(
          await repository.selectWorker({
            ...identity,
            jobId: params.job_id,
            applicationId: body.application_id,
          }),
          request,
        );
      },
      {
        params: jobIdParamsSchema,
        body: t.Object({ application_id: t.String({ format: 'uuid' }) }),
        headers: idempotencyHeadersSchema,
        response: commandResponses,
        detail: {
          tags: ['Funded jobs'],
          summary: 'Select one applicant and engage that worker atomically',
          operationId: 'selectWorker',
          security: [{ betterAuthSession: [] }],
        },
      },
    )
    .post(
      '/:job_id/work-submission',
      async ({ body, headers, params, request }) => {
        const identity = await commandIdentity(
          request,
          resolveSession,
          trustedOrigins,
          headers['idempotency-key'],
          { job_id: params.job_id, ...body },
        );
        return apiSuccess(
          await repository.submitWork({
            ...identity,
            jobId: params.job_id,
            summary: body.summary,
          }),
          request,
        );
      },
      {
        params: jobIdParamsSchema,
        body: t.Object({ summary: t.String({ minLength: 1, maxLength: 5_000 }) }),
        headers: idempotencyHeadersSchema,
        response: commandResponses,
        detail: {
          tags: ['Funded jobs'],
          summary: 'Submit completed work and start the review window',
          operationId: 'submitWork',
          security: [{ betterAuthSession: [] }],
        },
      },
    )
    .post(
      '/:job_id/approval',
      async ({ headers, params, request }) => {
        const identity = await commandIdentity(
          request,
          resolveSession,
          trustedOrigins,
          headers['idempotency-key'],
          { job_id: params.job_id },
        );
        return apiSuccess(
          await repository.approveWork({ ...identity, jobId: params.job_id }),
          request,
        );
      },
      {
        params: jobIdParamsSchema,
        headers: idempotencyHeadersSchema,
        response: commandResponses,
        detail: {
          tags: ['Funded jobs'],
          summary: 'Approve submitted work and settle held funds atomically',
          operationId: 'approveWork',
          security: [{ betterAuthSession: [] }],
        },
      },
    );
