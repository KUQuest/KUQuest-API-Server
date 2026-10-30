import { app } from '@/app';
import { db, sql } from '@/database/client';
import { authUser } from '@/database/schema/auth.schema';
import { memberNotification } from '@/database/schema/notification.schema';
import { auth } from '@/modules/auth';
import { recordMemberNotificationInTransaction } from '@/modules/notification';
import type { MemberNotificationType } from '@/modules/notification';

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
const record = async (
  memberId: string,
  minute: number,
  type: MemberNotificationType = 'PENALTY_RED_FLAG_APPLIED'
) => {
  const { notificationId } = await db.transaction((transaction) =>
    recordMemberNotificationInTransaction(transaction, {
      memberId,
      type,
      eventKey: `inbox:${randomUUID()}`,
      ...(type === 'PENALTY_RED_FLAG_APPLIED' ? { result: 'RED_FLAG' as const } : {}),
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
const counts = async (memberId: string) =>
  (
    (await (await memberRequest(memberId, '/api/v1/notifications/unread-count')).json()) as {
      data: { count: number; byCategory: Record<string, number> };
    }
  ).data;
const idsOf = (page: Page) => page.data.items.map((item) => item.id);

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
      category: 'PENALTY',
      createdAt: new Date(baseTime + 2 * 60_000).toISOString(),
      readAt: null,
      questId: null,
      questTitle: null,
      actorRole: null,
      result: 'RED_FLAG',
      expiresAt: null,
      cancellationReason: null,
      failureReason: null,
      assignmentId: null,
      disputeCaseId: null,
      disputeStatus: null,
      viewerWon: null,
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

  it('filters by category: single, repeated, comma list, and none', async () => {
    if (!postgresAvailable) return;
    const memberId = await createMember();
    const penalty = await record(memberId, 1);
    const quest = await record(memberId, 2, 'QUEST_ASSIGNED');
    const dispute = await record(memberId, 3, 'DISPUTE_CASE_DECIDED');

    expect(idsOf(await list(memberId, '?category=QUEST'))).toEqual([quest]);
    expect(idsOf(await list(memberId, '?category=QUEST&category=DISPUTE'))).toEqual([
      dispute,
      quest,
    ]);
    expect(idsOf(await list(memberId, '?category=PENALTY,DISPUTE'))).toEqual([dispute, penalty]);
    expect(idsOf(await list(memberId))).toEqual([dispute, quest, penalty]);
    expect((await memberRequest(memberId, '/api/v1/notifications?category=OTHER')).status).toBe(
      400
    );
    const [item] = (await list(memberId, '?category=DISPUTE')).data.items;
    expect(item?.category).toBe('DISPUTE');
  });

  it('counts unread by category with every key present', async () => {
    if (!postgresAvailable) return;
    const memberId = await createMember();
    expect(await counts(memberId)).toEqual({
      count: 0,
      byCategory: { PENALTY: 0, QUEST: 0, DISPUTE: 0 },
    });
    await record(memberId, 1);
    await record(memberId, 2, 'QUEST_ASSIGNED');
    await record(memberId, 3, 'QUEST_FAILED');
    const readQuest = await record(memberId, 4, 'QUEST_COMPLETED_DISPUTE_WINDOW_OPEN');
    await memberRequest(memberId, '/api/v1/notifications/read', { ids: [readQuest] });

    expect(await counts(memberId)).toEqual({
      count: 3,
      byCategory: { PENALTY: 1, QUEST: 2, DISPUTE: 0 },
    });
  });

  it('dismisses a quest row: hidden, read, counted out, idempotent', async () => {
    if (!postgresAvailable) return;
    const memberId = await createMember();
    const quest = await record(memberId, 1, 'QUEST_ASSIGNED');
    const keep = await record(memberId, 2, 'QUEST_FAILED');

    const first = await memberRequest(memberId, '/api/v1/notifications/dismiss', { ids: [quest] });
    expect(first.status).toBe(200);
    const [before] = await db
      .select()
      .from(memberNotification)
      .where(eq(memberNotification.id, quest));
    expect(before?.dismissedAt).not.toBeNull();
    expect(before?.readAt).not.toBeNull();
    await Bun.sleep(5);

    const repeat = await memberRequest(memberId, '/api/v1/notifications/dismiss', {
      ids: [quest],
    });
    expect(repeat.status).toBe(200);
    const [after] = await db
      .select()
      .from(memberNotification)
      .where(eq(memberNotification.id, quest));
    expect(after?.dismissedAt?.getTime()).toBe(before?.dismissedAt?.getTime());
    expect(idsOf(await list(memberId))).toEqual([keep]);
    expect(idsOf(await list(memberId, '?category=QUEST'))).toEqual([keep]);
    expect((await counts(memberId)).byCategory.QUEST).toBe(1);
  });

  it('refuses to dismiss a penalty row and changes nothing', async () => {
    if (!postgresAvailable) return;
    const memberId = await createMember();
    const penalty = await record(memberId, 1);
    const quest = await record(memberId, 2, 'QUEST_ASSIGNED');

    const response = await memberRequest(memberId, '/api/v1/notifications/dismiss', {
      ids: [quest, penalty],
    });

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      'NOTIFICATION_NOT_DISMISSABLE'
    );
    const rows = await db
      .select()
      .from(memberNotification)
      .where(eq(memberNotification.memberId, memberId));
    expect(rows.every((row) => row.dismissedAt === null && row.readAt === null)).toBe(true);
    expect(idsOf(await list(memberId))).toEqual([quest, penalty]);
  });

  it('ignores dismiss ids of another Member, even a penalty id', async () => {
    if (!postgresAvailable) return;
    const owner = await createMember();
    const other = await createMember();
    const ownerQuest = await record(owner, 1, 'QUEST_ASSIGNED');
    const ownerPenalty = await record(owner, 2);

    const response = await memberRequest(other, '/api/v1/notifications/dismiss', {
      ids: [ownerQuest, ownerPenalty],
    });

    expect(response.status).toBe(200);
    expect(idsOf(await list(owner))).toEqual([ownerPenalty, ownerQuest]);
    expect((await counts(owner)).count).toBe(2);
  });

  it('rejects a bad dismiss body', async () => {
    if (!postgresAvailable) return;
    const memberId = await createMember();
    const post = async (body: unknown) =>
      (await memberRequest(memberId, '/api/v1/notifications/dismiss', body)).status;

    expect(await post({})).toBe(400);
    expect(await post({ ids: [] })).toBe(400);
    expect(await post({ ids: ['not-a-uuid'] })).toBe(400);
    expect(await post({ ids: [randomUUID()], extra: 1 })).toBe(400);
    expect(await post({ ids: Array.from({ length: 101 }, () => randomUUID()) })).toBe(400);
  });

  it('reads all rows of one category only', async () => {
    if (!postgresAvailable) return;
    const memberId = await createMember();
    await record(memberId, 1);
    await record(memberId, 2, 'QUEST_ASSIGNED');
    await record(memberId, 3, 'DISPUTE_CASE_DECIDED');

    const response = await memberRequest(memberId, '/api/v1/notifications/read', {
      all: true,
      category: 'QUEST',
    });

    expect(response.status).toBe(200);
    expect((await counts(memberId)).byCategory).toEqual({ PENALTY: 1, QUEST: 0, DISPUTE: 1 });
    await memberRequest(memberId, '/api/v1/notifications/read', {
      all: true,
      category: ['PENALTY', 'DISPUTE'],
    });
    expect((await counts(memberId)).count).toBe(0);
  });

  it('rejects a category with ids or an unknown read form', async () => {
    if (!postgresAvailable) return;
    const memberId = await createMember();
    const id = await record(memberId, 1, 'QUEST_ASSIGNED');
    const post = async (body: unknown) => {
      const response = await memberRequest(memberId, '/api/v1/notifications/read', body);
      return [
        response.status,
        ((await response.json()) as { error?: { code: string } }).error?.code,
      ];
    };

    expect(await post({ ids: [id], category: 'QUEST' })).toEqual([
      400,
      'INVALID_NOTIFICATION_READ_TARGET',
    ]);
    expect(await post({ category: 'QUEST' })).toEqual([400, 'INVALID_NOTIFICATION_READ_TARGET']);
    expect((await post({ all: true, category: 'OTHER' }))[0]).toBe(400);
    expect(await unreadCount(memberId)).toBe(1);
  });

  it('lets a banned Member use the inbox but not other routes', async () => {
    if (!postgresAvailable) return;
    const memberId = await createMember();
    const quest = await record(memberId, 1, 'QUEST_ASSIGNED');
    await db
      .update(authUser)
      .set({ bannedUntil: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) })
      .where(eq(authUser.id, memberId));

    expect(idsOf(await list(memberId))).toEqual([quest]);
    expect((await counts(memberId)).count).toBe(1);
    expect(
      (await memberRequest(memberId, '/api/v1/notifications/read', { all: true })).status
    ).toBe(200);
    expect(
      (await memberRequest(memberId, '/api/v1/notifications/dismiss', { ids: [quest] })).status
    ).toBe(200);
    const blocked = await memberRequest(memberId, '/api/v1/push/devices');
    expect(blocked.status).toBe(403);
    expect(((await blocked.json()) as { error: { code: string } }).error.code).toBe(
      'MEMBER_BANNED'
    );
  });
});
