import { createApp } from '@/app';
import { db, sql } from '@/database/client';
import { memberNotification } from '@/database/schema/notification.schema';
import { insertMemberNotificationInTransaction } from '@/modules/notification';

import { createStagingTestAuthRoute } from '../../fixtures/seeded-test-auth';
import { QuestWebSocketClient } from '../quest/quest-update-test-client';

import { randomUUID } from 'node:crypto';

import { Elysia } from 'elysia';
import { inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

const password = 'TestStudent1!';
const eventsPath = '/api/v1/notifications/events';
const members = ['one', 'two'].map((name) => ({
  email: `notification-events-${name}-${randomUUID()}@ku.th`,
  firstName: 'Notification',
  lastName: name,
}));
const memberIds: string[] = [];
const cookies: string[] = [];
let stopServer: () => Promise<unknown>;
let port: number;

const signIn = async (member: (typeof members)[number]) => {
  const auth = new Elysia().use(
    createStagingTestAuthRoute({ enabled: true, deploymentEnv: 'staging', ...member, password })
  );
  const response = await auth.handle(
    new Request('http://localhost/api/staging/test-auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: member.email, password }),
    })
  );
  if (response.status !== 200) throw new Error(`Test authentication failed: ${response.status}`);
  const body = (await response.json()) as { user: { id: string } };
  const cookie = (response.headers.getSetCookie?.() ?? [])
    .map((value) => value.split(';', 1)[0])
    .join('; ');
  return { id: body.user.id, cookie };
};

const connect = async (cookie: string, origin: string | null = null) => {
  const client = await QuestWebSocketClient.connect(port, '', cookie, origin, eventsPath);
  return client;
};

const subscribed = async (cookie: string) => {
  const client = await connect(cookie);
  expect(JSON.parse((await client.nextText())!)).toEqual({ type: 'SUBSCRIBED', version: 1 });
  return client;
};

const insert = (memberId: string, eventKey: string, rollback = false) =>
  db.transaction(async (transaction) => {
    const recorded = await insertMemberNotificationInTransaction(transaction, {
      memberId,
      type: 'PENALTY_RED_FLAG_APPLIED',
      eventKey,
      result: 'RED_FLAG',
      now: new Date(),
    });
    if (rollback) throw new Error('rollback');
    return recorded;
  });

beforeAll(async () => {
  await sql`select 1`;
  for (const member of members) {
    const signedIn = await signIn(member);
    memberIds.push(signedIn.id);
    cookies.push(signedIn.cookie);
  }
  const server = createApp().listen({ hostname: '127.0.0.1', port: 0 });
  stopServer = () => server.stop();
  port = server.server!.port!;
});

afterAll(async () => {
  await stopServer();
  await db.delete(memberNotification).where(inArray(memberNotification.memberId, memberIds));
});

describe('Member inbox events socket', () => {
  it('rejects a request without a session', async () => {
    const error = await connect('').then(
      () => undefined,
      (caught: unknown) => caught
    );
    expect((error as Error).message).toContain(' 401 ');
  });

  it('closes a socket from an untrusted Origin with code 4403', async () => {
    const socket = await connect(cookies[0]!, 'https://untrusted.example');
    try {
      const frame = await socket.nextFrame();
      expect(frame?.opcode).toBe(8);
      expect(frame?.payload.readUInt16BE(0)).toBe(4403);
    } finally {
      socket.destroy();
    }
  });

  it('sends one empty frame to the recipient only after the insert commits', async () => {
    const own = await subscribed(cookies[0]!);
    const other = await subscribed(cookies[1]!);
    try {
      await insert(memberIds[0]!, `events:${randomUUID()}`);
      expect(JSON.parse((await own.nextText())!)).toEqual({ type: 'NOTIFICATIONS_CHANGED' });
      expect(await other.nextText(300)).toBeUndefined();
    } finally {
      own.destroy();
      other.destroy();
    }
  });

  it('sends nothing when the transaction rolls back', async () => {
    const own = await subscribed(cookies[0]!);
    try {
      await expect(insert(memberIds[0]!, `events:${randomUUID()}`, true)).rejects.toThrow(
        'rollback'
      );
      expect(await own.nextText(300)).toBeUndefined();
    } finally {
      own.destroy();
    }
  });

  it('sends no frame for a replay of the same event key', async () => {
    const eventKey = `events:${randomUUID()}`;
    const own = await subscribed(cookies[0]!);
    try {
      expect((await insert(memberIds[0]!, eventKey)).created).toBe(true);
      expect(JSON.parse((await own.nextText())!)).toEqual({ type: 'NOTIFICATIONS_CHANGED' });
      expect((await insert(memberIds[0]!, eventKey)).created).toBe(false);
      expect(await own.nextText(300)).toBeUndefined();
    } finally {
      own.destroy();
    }
  });
});
