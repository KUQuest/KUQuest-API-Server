import { app } from '@/app';
import { createStagingTestAuthRoute } from '@/modules/auth/staging-test-auth.route';

import { Elysia } from 'elysia';
import { describe, expect, it } from 'bun:test';

const testAuthApp = new Elysia({ name: 'payout-destination-test-auth' }).use(
  createStagingTestAuthRoute({
    enabled: true,
    deploymentEnv: 'staging',
    email: `payout-dest-${crypto.randomUUID()}@ku.th`,
    password: 'TestStudent1!',
    firstName: 'Payout',
    lastName: 'Tester',
  }),
);

const getCookieHeader = (response: Response): string =>
  (response.headers.getSetCookie?.() ?? [])
    .map((cookie) => cookie.split(';', 1)[0])
    .join('; ');

const signInTestMember = async (): Promise<string> => {
  const loginResponse = await testAuthApp.handle(
    new Request('http://localhost/api/staging/test-auth/sign-in/default', {
      method: 'POST',
    }),
  );
  expect(loginResponse.status).toBe(200);
  const cookie = getCookieHeader(loginResponse);
  if (!cookie) throw new Error('Failed to extract session cookie from staging test auth login.');
  return cookie;
};

describe('Payout Destination HTTP routes', () => {
  it('requires Member authentication for all Payout Destination operations', async () => {
    const unauthenticatedGet = await app.handle(
      new Request('http://localhost/api/v1/payout-destinations'),
    );
    const unauthenticatedPost = await app.handle(
      new Request('http://localhost/api/v1/payout-destinations', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          givenName: 'Test',
          surname: 'Student',
          accountHolderName: 'Test Student',
          bankCode: 'KBANK',
          accountNumber: '1234567890',
        }),
      }),
    );
    const unauthenticatedDelete = await app.handle(
      new Request('http://localhost/api/v1/payout-destinations', {
        method: 'DELETE',
      }),
    );

    expect(unauthenticatedGet.status).toBe(401);
    expect(unauthenticatedPost.status).toBe(401);
    expect(unauthenticatedDelete.status).toBe(401);
  });

  it('publishes Payout Destination paths in OpenAPI', async () => {
    const response = await app.handle(new Request('http://localhost/openapi/json'));
    const document = (await response.json()) as {
      paths: Record<string, Record<string, { operationId?: string }>>;
    };

    expect(response.status).toBe(200);
    expect(document.paths['/api/v1/payout-destinations']?.get?.operationId).toBe(
      'getActivePayoutDestination',
    );
    expect(document.paths['/api/v1/payout-destinations']?.post?.operationId).toBe(
      'saveActivePayoutDestination',
    );
    expect(document.paths['/api/v1/payout-destinations']?.delete?.operationId).toBe(
      'retireActivePayoutDestination',
    );
  });

  it('handles save, get, and retire lifecycle for an authenticated Student', async () => {
    const cookie = await signInTestMember();

    // Clean up any existing active destination first
    await app.handle(
      new Request('http://localhost/api/v1/payout-destinations', {
        method: 'DELETE',
        headers: { cookie },
      }),
    );

    // Initial read should return null
    const initialGet = await app.handle(
      new Request('http://localhost/api/v1/payout-destinations', {
        headers: { cookie },
      }),
    );
    expect(initialGet.status).toBe(200);
    const initialData = (await initialGet.json()) as { success: boolean; data: unknown };
    expect(initialData.success).toBe(true);
    expect(initialData.data).toBeNull();

    // Save active destination
    const saveResponse = await app.handle(
      new Request('http://localhost/api/v1/payout-destinations', {
        method: 'POST',
        headers: {
          cookie,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          givenName: 'Somchai',
          surname: 'Jaidee',
          accountHolderName: 'Somchai Jaidee',
          bankCode: 'SCB',
          accountNumber: '9876543210',
          routingType: 'BANK_ACCOUNT',
        }),
      }),
    );
    expect(saveResponse.status).toBe(200);
    const saveData = (await saveResponse.json()) as {
      success: boolean;
      data: {
        id: string;
        bankCode: string;
        accountHolderName: string;
        maskedLastFour: string;
        maskedRoutingValue: string;
        routingType: string;
        retiredAt: null;
      };
    };
    expect(saveData.success).toBe(true);
    expect(saveData.data.bankCode).toBe('SCB');
    expect(saveData.data.accountHolderName).toBe('Somchai Jaidee');
    expect(saveData.data.maskedLastFour).toBe('3210');
    expect(saveData.data.maskedRoutingValue).toBe('****3210');
    expect(saveData.data.routingType).toBe('BANK_ACCOUNT');
    expect(saveData.data.retiredAt).toBeNull();
    // Verify full account number is never exposed in the response
    expect(JSON.stringify(saveData)).not.toContain('9876543210');

    // Read active destination
    const getResponse = await app.handle(
      new Request('http://localhost/api/v1/payout-destinations', {
        headers: { cookie },
      }),
    );
    expect(getResponse.status).toBe(200);
    const getData = (await getResponse.json()) as typeof saveData;
    expect(getData.data.id).toBe(saveData.data.id);
    expect(getData.data.maskedLastFour).toBe('3210');
    expect(getData.data.maskedRoutingValue).toBe('****3210');

    // Retire active destination
    const deleteResponse = await app.handle(
      new Request('http://localhost/api/v1/payout-destinations', {
        method: 'DELETE',
        headers: { cookie },
      }),
    );
    expect(deleteResponse.status).toBe(200);
    const deleteData = (await deleteResponse.json()) as { success: boolean; data: { retired: boolean } };
    expect(deleteData.success).toBe(true);
    expect(deleteData.data.retired).toBe(true);

    // Read after retire should return null
    const afterDeleteGet = await app.handle(
      new Request('http://localhost/api/v1/payout-destinations', {
        headers: { cookie },
      }),
    );
    expect(afterDeleteGet.status).toBe(200);
    const afterDeleteData = (await afterDeleteGet.json()) as { success: boolean; data: unknown };
    expect(afterDeleteData.data).toBeNull();
  });

  it('rejects invalid destination input with 400', async () => {
    const cookie = await signInTestMember();

    const invalidBank = await app.handle(
      new Request('http://localhost/api/v1/payout-destinations', {
        method: 'POST',
        headers: {
          cookie,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          givenName: 'Test',
          surname: 'Student',
          accountHolderName: 'Test Student',
          bankCode: 'NOT_A_BANK',
          accountNumber: '1234567890',
        }),
      }),
    );

    expect(invalidBank.status).toBe(400);
  });
});
