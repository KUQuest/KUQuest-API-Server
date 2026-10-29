import { app } from '@/app';
import { env } from '@/config/env';
import { db, sql } from '@/database/client';
import { authAdmin } from '@/database/schema/auth.schema';
import {
  adminUpdateListenerApplicationName,
  notifyAdminResourceUpdated,
  stopAdminUpdateListener,
} from '@/modules/admin/admin-update.delivery';
import { auth } from '@/modules/auth';
import { createAdminAuth } from '@/modules/auth/admin-auth.config';

import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test';

const adminPassword = 'AdminUpdatePass1!';
const adminEmails = [
  `admin-update-one-${crypto.randomUUID()}@example.com`,
  `admin-update-two-${crypto.randomUUID()}@example.com`,
];
let databaseReady = false;
const adminIds: string[] = [];
const adminCookies: string[] = [];

const getCookieHeader = (response: Response): string =>
  (response.headers.getSetCookie?.() ?? []).map((cookie) => cookie.split(';', 1)[0]).join('; ');

const loginAdmin = async (email: string) => {
  const adminAuth = createAdminAuth({
    allowSignUp: true,
    autoSignIn: false,
    markEmailVerified: true,
  });
  const account = await adminAuth.api.signUpEmail({
    body: {
      email,
      password: adminPassword,
      name: 'Update Admin',
      firstName: 'Update',
      lastName: 'Admin',
    },
  });
  const response = await app.handle(
    new Request('http://localhost/api/admin/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: adminPassword }),
    })
  );
  if (response.status !== 200) throw new Error(`Admin sign-in failed: ${response.status}`);
  return { id: account.user.id, cookie: getCookieHeader(response) };
};

const adminEventsRequest = (cookie = adminCookies[0]!, origin?: string) =>
  app.handle(
    new Request('http://localhost/api/v1/admin/events', {
      headers: {
        cookie,
        ...(origin ? { origin } : {}),
      },
    })
  );

type AdminSseReadResult = Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']>>;

const pendingReads = new WeakMap<
  ReadableStreamDefaultReader<Uint8Array>,
  Promise<AdminSseReadResult>
>();

const readNextChunk = (reader: ReadableStreamDefaultReader<Uint8Array>) => {
  let pending = pendingReads.get(reader);
  if (!pending) {
    pending = reader.read().finally(() => pendingReads.delete(reader));
    pendingReads.set(reader, pending);
  }
  return pending;
};

const readWithTimeout = async (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMessage: string,
  timeoutMs: number
) => {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      readNextChunk(reader),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
};

const readText = async (reader: ReadableStreamDefaultReader<Uint8Array>) => {
  const next = await readWithTimeout(reader, 'Timed out waiting for Admin SSE data.', 5_000);
  if (next.done) throw new Error('Admin SSE stream closed before the expected event.');
  return new TextDecoder().decode(next.value);
};

const expectStreamToClose = async (reader: ReadableStreamDefaultReader<Uint8Array>) => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = await readWithTimeout(
      reader,
      'Timed out waiting for Admin SSE stream to close.',
      deadline - Date.now()
    );
    if (result.done) return;
  }
  throw new Error('Timed out waiting for Admin SSE stream to close.');
};

const readEvent = async (reader: ReadableStreamDefaultReader<Uint8Array>) => {
  const frame = await readText(reader);
  const data = frame.split('\n').find((line) => line.startsWith('data: '));
  if (!data) throw new Error(`Admin SSE frame did not contain event data: ${frame}`);
  return JSON.parse(data.slice('data: '.length)) as Record<string, unknown>;
};

const readEventFor = async (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  subjectType: string,
  subjectId: string
) => {
  while (true) {
    const event = await readEvent(reader);
    if (event.subjectType === subjectType && event.subjectId === subjectId) return event;
  }
};

const expectNoEventFor = async (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  subjectType: string,
  subjectId: string,
  timeoutMs = 250
) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let result: AdminSseReadResult;
    try {
      result = await readWithTimeout(
        reader,
        'Timed out waiting for duplicate Admin SSE data.',
        deadline - Date.now()
      );
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === 'Timed out waiting for duplicate Admin SSE data.'
      )
        return;
      throw error;
    }
    if (result.done) throw new Error('Admin SSE stream closed while checking for duplicates.');
    const dataLine = new TextDecoder()
      .decode(result.value)
      .split('\n')
      .find((line) => line.startsWith('data: '));
    if (!dataLine) continue;
    const event = JSON.parse(dataLine.slice('data: '.length)) as Record<string, unknown>;
    if (event.subjectType === subjectType && event.subjectId === subjectId) {
      throw new Error(`Received a duplicate Admin SSE event: ${JSON.stringify(event)}`);
    }
  }
};

beforeAll(async () => {
  try {
    await sql`select 1`;
    const [tables] = await sql<{ admin: string | null }[]>`
      select to_regclass('public.auth_admin') as admin
    `;
    databaseReady = tables?.admin !== null;
  } catch {
    console.warn('Skipping Admin update tests: PostgreSQL is unavailable');
    return;
  }
  if (!databaseReady) return;

  const admins = await Promise.all(adminEmails.map(loginAdmin));
  adminIds.push(...admins.map(({ id }) => id));
  adminCookies.push(...admins.map(({ cookie }) => cookie));
});

afterAll(async () => {
  if (!databaseReady) return;
  if (adminIds.length > 0) await db.delete(authAdmin).where(inArray(authAdmin.id, adminIds));
});

describe('Admin SSE updates', () => {
  it('documents the SSE media type, event contract, and access errors in OpenAPI', async () => {
    if (!databaseReady) return;
    const response = await app.handle(new Request('http://localhost/openapi/json'));
    const document = (await response.json()) as {
      paths: Record<
        string,
        Record<
          string,
          {
            operationId?: string;
            description?: string;
            security?: Array<Record<string, unknown>>;
            responses?: Record<
              string,
              {
                content?: Record<string, { example?: string; examples?: Record<string, unknown> }>;
              }
            >;
          }
        >
      >;
    };
    const operation = document.paths['/api/v1/admin/events']?.get;

    expect(response.status).toBe(200);
    expect(operation?.operationId).toBe('subscribeAdminUpdates');
    expect(operation?.description).toContain('GET /api/v1/admin/reports/{reportId}');
    expect(operation?.description).toContain('GET /api/v1/admin/overview');
    expect(operation?.description).toContain('GET /api/v1/admin/members/{id}/penalty-history');
    expect(operation?.description).toContain('GET /api/v1/admin/activity-log');
    expect(operation?.description).toContain('GET /api/v1/admin/disputes/{disputeCaseId}');
    expect(operation?.description).toContain('GET /api/v1/admin/quests/{questId}');
    expect(operation?.description).toContain('GET /api/v1/admin/finance/quests/{questId}');
    expect(operation?.description).toContain('GET /api/v1/admin/wallets/{walletId}');
    expect(operation?.description).toContain('GET /api/v1/admin/finance/members/{userId}');
    expect(operation?.description).toContain('wallet.id` equal to the event `subjectId`');
    expect(operation?.description).toContain('response value `member.userId` for `{userId}`');
    expect(operation?.description).toContain('active Funding Reservations');
    expect(operation?.description).toContain(
      'GET /api/v1/admin/finance/ledger/transactions?walletId={walletId}'
    );
    expect(operation?.description).toContain('Other resource types need a documented read mapping');
    expect(operation?.security?.[0]).toHaveProperty('betterAuthAdminSession');
    expect(operation?.responses).toHaveProperty('401');
    expect(operation?.responses).toHaveProperty('403');
    expect(operation?.responses).toHaveProperty('503');
    expect(operation?.responses?.['200']?.content).toHaveProperty('text/event-stream');
    expect(operation?.responses?.['200']?.content?.['text/event-stream']?.example).toContain(
      'CONDUCT_REPORT'
    );
  });

  it('allows enabled Admins and rejects anonymous, Member, disabled, and untrusted-origin callers', async () => {
    if (!databaseReady) return;

    const anonymous = await app.handle(new Request('http://localhost/api/v1/admin/events'));
    expect(anonymous.status).toBe(401);

    const memberAuth = spyOn(auth.api, 'getSession').mockImplementation((async ({
      headers,
    }: {
      headers: Headers;
    }) =>
      headers.get('x-test-member')
        ? ({ user: { id: 'member-test' }, session: { userId: 'member-test' } } as never)
        : null) as never);
    try {
      const member = await app.handle(
        new Request('http://localhost/api/v1/admin/events', {
          headers: { 'x-test-member': 'member-test' },
        })
      );
      expect(member.status).toBe(403);
    } finally {
      memberAuth.mockRestore();
    }

    const [admin] = await db
      .select({ id: authAdmin.id })
      .from(authAdmin)
      .where(eq(authAdmin.id, adminIds[0]!));
    if (!admin) throw new Error('Admin test account is missing.');
    await db.update(authAdmin).set({ disabledAt: new Date() }).where(eq(authAdmin.id, admin.id));
    try {
      const disabled = await adminEventsRequest();
      expect(disabled.status).toBe(403);
    } finally {
      await db.update(authAdmin).set({ disabledAt: null }).where(eq(authAdmin.id, admin.id));
    }

    const untrustedOrigin = await adminEventsRequest(adminCookies[0], 'https://untrusted.example');
    expect(untrustedOrigin.status).toBe(403);

    const enabled = await adminEventsRequest(
      adminCookies[0],
      env.cmsOrigin || 'http://localhost:3000'
    );
    expect(enabled.status).toBe(200);
    expect(enabled.headers.get('content-type')).toContain('text/event-stream');
    expect(enabled.headers.get('access-control-allow-credentials')).toBe('true');
    await enabled.body?.cancel();
  });

  it('delivers only committed resource IDs across API processes and Admin connections', async () => {
    if (!databaseReady) return;

    const childSource = [
      "import { app } from './src/app.ts';",
      "import { ensureAdminUpdateListener } from './src/modules/admin/admin-update.delivery.ts';",
      'await ensureAdminUpdateListener();',
      "const server = app.listen({ hostname: '127.0.0.1', port: 0 });",
      "console.log('READY:' + server.server?.port);",
    ].join('\n');
    const child = Bun.spawn(['bun', '-e', childSource], {
      cwd: process.cwd(),
      env: process.env,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const childOutput = child.stdout.getReader();
    let childReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let localReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const ready = await readText(childOutput);
      const port = Number(ready.match(/READY:(\d+)/)?.[1]);
      if (!Number.isInteger(port) || port < 1)
        throw new Error(`API process did not start: ${ready}`);

      const remoteResponse = await fetch(`http://127.0.0.1:${port}/api/v1/admin/events`, {
        headers: { cookie: adminCookies[1]!, origin: env.cmsOrigin || 'http://localhost:3000' },
      });
      const localResponse = await adminEventsRequest(adminCookies[0]);
      expect(remoteResponse.status).toBe(200);
      expect(localResponse.status).toBe(200);
      childReader = remoteResponse.body!.getReader();
      localReader = localResponse.body!.getReader();
      const connectedFrames = await Promise.all([readText(childReader), readText(localReader)]);
      for (const frame of connectedFrames) expect(frame).toContain(': connected');

      const rolledBackId = crypto.randomUUID();
      await expect(
        db.transaction(async (transaction) => {
          await notifyAdminResourceUpdated(transaction, 'CONDUCT_REPORT', rolledBackId);
          throw new Error('force transaction rollback');
        })
      ).rejects.toThrow('force transaction rollback');

      const subjectId = crypto.randomUUID();
      await db.transaction((transaction) =>
        notifyAdminResourceUpdated(transaction, 'CONDUCT_REPORT', subjectId)
      );

      const events = await Promise.all([
        readEventFor(childReader, 'CONDUCT_REPORT', subjectId),
        readEventFor(localReader, 'CONDUCT_REPORT', subjectId),
      ]);
      for (const event of events) {
        expect(event).toEqual({
          type: 'RESOURCE_UPDATED',
          subjectType: 'CONDUCT_REPORT',
          subjectId,
        });
        expect(JSON.stringify(event)).not.toContain(rolledBackId);
        expect(Object.keys(event).sort()).toEqual(['subjectId', 'subjectType', 'type']);
      }
      await Promise.all([
        expectNoEventFor(childReader, 'CONDUCT_REPORT', subjectId),
        expectNoEventFor(localReader, 'CONDUCT_REPORT', subjectId),
      ]);
    } finally {
      await Promise.all([childReader?.cancel(), localReader?.cancel()]);
      child.kill();
      await child.exited;
      await childOutput.cancel();
    }
  });

  it('closes open streams when the database listener restarts so clients can reconnect', async () => {
    if (!databaseReady) return;

    const response = await adminEventsRequest(adminCookies[0]);
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    expect(await readText(reader)).toContain(': connected');

    await stopAdminUpdateListener();
    expect((await reader.read()).done).toBe(true);
    await reader.cancel();

    const reconnected = await adminEventsRequest(adminCookies[0]);
    expect(reconnected.status).toBe(200);
    const reconnectReader = reconnected.body!.getReader();
    try {
      expect(await readText(reconnectReader)).toContain(': connected');
    } finally {
      await reconnectReader.cancel();
    }
  });

  it('cleans listener callbacks after a PostgreSQL disconnect and repeated restarts', async () => {
    if (!databaseReady) return;

    const response = await adminEventsRequest(adminCookies[0]);
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    try {
      expect(await readText(reader)).toContain(': connected');
      const streamClose = expectStreamToClose(reader);

      const [listener] = await sql<{ pid: number }[]>`
        select pid
        from pg_stat_activity
        where datname = current_database()
          and pid <> pg_backend_pid()
          and application_name = ${adminUpdateListenerApplicationName}
          and state = 'idle'
          and query = 'listen "kuquest_admin_updates"'
        limit 1
      `;
      if (!listener) throw new Error('Admin update PostgreSQL listener is missing.');

      const [{ terminated }] = await sql<{ terminated: boolean }[]>`
        select pg_terminate_backend(${listener.pid}) as terminated
      `;
      expect(terminated).toBe(true);
      await streamClose;

      const reconnected = await adminEventsRequest(adminCookies[0]);
      expect(reconnected.status).toBe(200);
      const reconnectReader = reconnected.body!.getReader();
      try {
        expect(await readText(reconnectReader)).toContain(': connected');
        await stopAdminUpdateListener();
        const closed = await readWithTimeout(
          reconnectReader,
          'Timed out waiting for restarted Admin SSE stream to close.',
          1_000
        );
        expect(closed.done).toBe(true);
      } finally {
        await reconnectReader.cancel();
      }

      const restarted = await adminEventsRequest(adminCookies[0]);
      expect(restarted.status).toBe(200);
      const restartedReader = restarted.body!.getReader();
      try {
        expect(await readText(restartedReader)).toContain(': connected');
        const subjectId = crypto.randomUUID();
        await db.transaction((transaction) =>
          notifyAdminResourceUpdated(transaction, 'CONDUCT_REPORT', subjectId)
        );
        expect(await readEventFor(restartedReader, 'CONDUCT_REPORT', subjectId)).toEqual({
          type: 'RESOURCE_UPDATED',
          subjectType: 'CONDUCT_REPORT',
          subjectId,
        });
        await expectNoEventFor(restartedReader, 'CONDUCT_REPORT', subjectId);

        await stopAdminUpdateListener();
        const closed = await readWithTimeout(
          restartedReader,
          'Timed out waiting for restarted Admin SSE stream to close.',
          1_000
        );
        expect(closed.done).toBe(true);
      } finally {
        await restartedReader.cancel();
      }

      const restartedAgain = await adminEventsRequest(adminCookies[0]);
      expect(restartedAgain.status).toBe(200);
      const restartedAgainReader = restartedAgain.body!.getReader();
      try {
        expect(await readText(restartedAgainReader)).toContain(': connected');
        const subjectId = crypto.randomUUID();
        await db.transaction((transaction) =>
          notifyAdminResourceUpdated(transaction, 'CONDUCT_REPORT', subjectId)
        );
        expect(await readEventFor(restartedAgainReader, 'CONDUCT_REPORT', subjectId)).toEqual({
          type: 'RESOURCE_UPDATED',
          subjectType: 'CONDUCT_REPORT',
          subjectId,
        });
        await expectNoEventFor(restartedAgainReader, 'CONDUCT_REPORT', subjectId);
      } finally {
        await restartedAgainReader.cancel();
      }
    } finally {
      await reader.cancel();
    }
  });
});
