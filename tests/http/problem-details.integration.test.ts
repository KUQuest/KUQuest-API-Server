import { describe, expect, it } from 'bun:test';

import { createApp } from '@/app';
import { InMemoryMoneyRepository } from '@/modules/money/in-memory-money.repository';

const createTestApp = (authenticated = true) => {
  const repository = new InMemoryMoneyRepository();
  let sessionResolutionCount = 0;

  const app = createApp({
    moneyRepository: repository,
    sessionResolver: async () => {
      sessionResolutionCount += 1;
      return authenticated ? { user: { id: 'problem-contract-user' } } : null;
    },
    trustedOrigins: ['http://localhost:3000'],
    xenditWebhookToken: 'problem-contract-webhook-token',
  });

  return {
    app,
    sessionResolutionCount: () => sessionResolutionCount,
  };
};

describe('HTTP problem details contract', () => {
  it('returns a structured authentication error and preserves the caller trace ID', async () => {
    const { app } = createTestApp(false);
    const response = await app.handle(
      new Request('http://localhost/v1/wallet', {
        headers: { 'x-trace-id': 'trace-problem-contract-0001' },
      }),
    );

    expect(response.status).toBe(401);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.json()).toEqual({
      success: false,
      data: null,
      error: {
        type: 'https://api.kuquest.app/problems/unauthorized',
        title: 'Unauthorized',
        status: 401,
        code: 'UNAUTHORIZED',
        detail: 'A valid session is required.',
        issues: [],
      },
      trace_id: 'trace-problem-contract-0001',
    });
  });

  it('rejects invalid query input before resolving a user session', async () => {
    const testApp = createTestApp();
    const response = await testApp.app.handle(
      new Request('http://localhost/v1/wallet/activities?limit=101', {
        headers: { 'x-trace-id': 'trace-problem-contract-0002' },
      }),
    );

    expect(response.status).toBe(422);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.json()).toMatchObject({
      success: false,
      data: null,
      error: {
        type: 'https://api.kuquest.app/problems/validation-failed',
        title: 'Validation Failed',
        status: 422,
        code: 'VALIDATION_FAILED',
        detail: 'The request did not match the required schema.',
        issues: [
          {
            path: '/',
            message: expect.any(String),
          },
        ],
      },
      trace_id: 'trace-problem-contract-0002',
    });
    expect(testApp.sessionResolutionCount()).toBe(0);
  });

  it('returns the same failure envelope for an unknown route', async () => {
    const { app } = createTestApp();
    const response = await app.handle(
      new Request('http://localhost/v1/not-a-real-resource', {
        headers: { 'x-trace-id': 'trace-problem-contract-0003' },
      }),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      success: false,
      data: null,
      error: {
        type: 'https://api.kuquest.app/problems/not-found',
        title: 'Not Found',
        status: 404,
        code: 'NOT_FOUND',
        detail: 'The requested resource was not found.',
        issues: [],
      },
      trace_id: 'trace-problem-contract-0003',
    });
  });

  it('returns a safe failure envelope for malformed JSON', async () => {
    const { app } = createTestApp();
    const response = await app.handle(
      new Request('http://localhost/v1/wallet/earnings-conversions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'malformed-json-request-0001',
          origin: 'http://localhost:3000',
          'x-trace-id': 'trace-problem-contract-0004',
        },
        body: '{',
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      success: false,
      data: null,
      error: {
        type: 'https://api.kuquest.app/problems/invalid-request-body',
        title: 'Invalid Request Body',
        status: 400,
        code: 'INVALID_REQUEST_BODY',
        detail: 'The request body could not be parsed.',
        issues: [],
      },
      trace_id: 'trace-problem-contract-0004',
    });
  });

  it('hides internal details while returning a traceable 500 envelope', async () => {
    const repository = new InMemoryMoneyRepository();
    repository.getWallet = async () => {
      throw new Error('sensitive database detail');
    };
    const app = createApp({
      moneyRepository: repository,
      sessionResolver: async () => ({ user: { id: 'problem-contract-user' } }),
      xenditWebhookToken: 'problem-contract-webhook-token',
    });
    const response = await app.handle(
      new Request('http://localhost/v1/wallet', {
        headers: { 'x-trace-id': 'trace-problem-contract-0005' },
      }),
    );

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body).toEqual({
      success: false,
      data: null,
      error: {
        type: 'https://api.kuquest.app/problems/internal-error',
        title: 'Internal Error',
        status: 500,
        code: 'INTERNAL_ERROR',
        detail: 'An unexpected error occurred.',
        issues: [],
      },
      trace_id: 'trace-problem-contract-0005',
    });
    expect(JSON.stringify(body)).not.toContain('sensitive database detail');
  });
});
