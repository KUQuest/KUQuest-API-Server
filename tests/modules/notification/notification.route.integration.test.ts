import { app } from '@/app';
import { db, sql } from '@/database/client';
import { authUser } from '@/database/schema/auth.schema';
import { memberNotification } from '@/database/schema/notification.schema';
import { auth } from '@/modules/auth';
import { recordMemberNotificationInTransaction } from '@/modules/notification';

import { randomUUID } from 'node:crypto';

import { eq, inArray } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from 'bun:test';

let postgresAvailable = false;
const memberIds: string[] = [];
const baseTime = new Date('2030-01-01T00:00:00.000Z').getTime();

const createMember = async () => {
  const id = randomUUID();
  await db.insert(authUser).values({
    id,
    email: `${id}@notification-route.test`,
    firstName: 'Notification',
    lastName: 'Route',
  });
  memberIds.push(id);
  return id;
};

/** Records one row; a larger `minute` means a newer row. */
const record = async (memberId: string, minute: number) => {
  const { notificationId } = await db.transaction((transaction) =>
    recordMemberNotificationInTransaction(transaction, {
      memberId,
      type: 'PENALTY_RED_FLAG_APPLIED',
      eventKey: `penalty:${randomUUID()}`,
      result: 'RED_FLAG',
      now: new Date(baseTime + minute * 60_000),
    })
  );
  return notificationId;
};

const memberRequest = (memberId: string, path: string, body?: unknown): Promise<Response> => {
  spyOn(auth.api, 'getSession').mockImplementation((async () => ({
    user: { id: memberId },
    session: { userId: memberId },
  })) as never);
  return app.handle(
    new Request(`http://localhost${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      ...(body === undefined
        ? {}
        : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
    })
  );
};

type Page = {
  data: {
    items: Array<{ id: string; readAt: string | null; [field: string]: unknown }>;
    nextCursor: string | null;
  };
};
const list = async (memberId: string, query = ''): Promise<Page> =>
  (await (await memberRequest(memberId, `/api/v1/notifications${query}`)).json()) as Page;
const unreadCount = async (memberId: string) =>
  (
    (await (await memberRequest(memberId, '/api/v1/notifications/unread-count')).json()) as {
      data: { count: number };
    }
  ).data.count;

beforeAll(async () => {
  try {
    await sql`select 1`;
    postgresAvailable = true;
  } catch {
    return;
  }
});

afterEach(async () => {
  if (!postgresAvailable || memberIds.length === 0) return;
  await db.delete(authUser).where(inArray(authUser.id, memberIds));
  memberIds.length = 0;
});

afterAll(() => {
  spyOn(auth.api, 'getSession').mockRestore();
});

describe('Member Notification inbox routes', () => {
  it('returns 401 without a session', async () => {
    const response = await app.handle(new Request('http://localhost/api/v1/notifications'));
    expect(response.status).toBe(401);
  });

  it('lists newest first with codes only', async () => {
    if (!postgresAvailable) return;
    const memberId = await createMember();
    const older = await record(memberId, 1);
    const newer = await record(memberId, 2);

    const page = await list(memberId);

    expect(page.data.items.map((item) => item.id)).toEqual([newer, older]);
    expect(page.data.nextCursor).toBeNull();
    expect(page.data.items[0]).toEqual({
      id: newer,
      type: 'PENALTY_RED_FLAG_APPLIED',
      createdAt: new Date(baseTime + 2 * 60_000).toISOString(),
      readAt: null,
      questId: null,
      result: 'RED_FLAG',
      expiresAt: null,
    });
  });

  it('pages with an opaque cursor and rejects a bad cursor', async () => {
    if (!postgresAvailable) return;
    const memberId = await createMember();
    const ids = [await record(memberId, 1), await record(memberId, 2), await record(memberId, 3)];

    const first = await list(memberId, '?limit=2');
    expect(first.data.items.map((item) => item.id)).toEqual([ids[2], ids[1]]);
    expect(first.data.nextCursor).not.toBeNull();
    const second = await list(
      memberId,
      `?limit=2&cursor=${encodeURIComponent(first.data.nextCursor ?? '')}`
    );
    expect(second.data.items.map((item) => item.id)).toEqual([ids[0]]);
    expect(second.data.nextCursor).toBeNull();

    expect((await memberRequest(memberId, '/api/v1/notifications?cursor=bad')).status).toBe(400);
    expect((await memberRequest(memberId, '/api/v1/notifications?limit=51')).status).toBe(400);
  });

  it('filters unread rows and counts them', async () => {
    if (!postgresAvailable) return;
    const memberId = await createMember();
    const readId = await record(memberId, 1);
    const unreadId = await record(memberId, 2);
    await memberRequest(memberId, '/api/v1/notifications/read', { ids: [readId] });

    const page = await list(memberId, '?unreadOnly=true');

    expect(page.data.items.map((item) => item.id)).toEqual([unreadId]);
    expect(await unreadCount(memberId)).toBe(1);
  });

  it('marks listed ids and keeps the first readAt on a repeat', async () => {
    if (!postgresAvailable) return;
    const memberId = await createMember();
    const first = await record(memberId, 1);
    const second = await record(memberId, 2);

    expect(
      (await memberRequest(memberId, '/api/v1/notifications/read', { ids: [first] })).status
    ).toBe(200);
    const [before] = await db
      .select()
      .from(memberNotification)
      .where(eq(memberNotification.id, first));
    expect(before?.readAt).not.toBeNull();
    await Bun.sleep(5);

    const repeat = await memberRequest(memberId, '/api/v1/notifications/read', {
      ids: [first, second],
    });
    expect(repeat.status).toBe(200);

    const [after] = await db
      .select()
      .from(memberNotification)
      .where(eq(memberNotification.id, first));
    expect(after?.readAt?.getTime()).toBe(before?.readAt?.getTime());
    expect(await unreadCount(memberId)).toBe(0);
  });

  it('marks all unread rows', async () => {
    if (!postgresAvailable) return;
    const memberId = await createMember();
    await record(memberId, 1);
    await record(memberId, 2);

    const response = await memberRequest(memberId, '/api/v1/notifications/read', { all: true });

    expect(response.status).toBe(200);
    expect(await unreadCount(memberId)).toBe(0);
  });

  it('ignores ids of another Member', async () => {
    if (!postgresAvailable) return;
    const owner = await createMember();
    const other = await createMember();
    const ownerRow = await record(owner, 1);
    await record(other, 1);

    const response = await memberRequest(other, '/api/v1/notifications/read', { ids: [ownerRow] });

    expect(response.status).toBe(200);
    expect(await unreadCount(owner)).toBe(1);
    expect(await unreadCount(other)).toBe(1);
    expect((await list(other)).data.items.map((item) => item.id)).not.toContain(ownerRow);
  });

  it('rejects a body with both forms, no form, or unknown fields', async () => {
    if (!postgresAvailable) return;
    const memberId = await createMember();
    const id = await record(memberId, 1);
    const post = async (body: unknown) =>
      (await memberRequest(memberId, '/api/v1/notifications/read', body)).status;

    expect(await post({ ids: [id], all: true })).toBe(400);
    expect(await post({})).toBe(400);
    expect(await post({ ids: [] })).toBe(400);
    expect(await post({ all: true, extra: 1 })).toBe(400);
    expect(await unreadCount(memberId)).toBe(1);
  });
});
