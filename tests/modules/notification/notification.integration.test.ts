import { app } from '@/app';
import { db, sql as postgresSql } from '@/database/client';
import { authUser } from '@/database/schema/auth.schema';
import { notification, notificationDevice } from '@/database/schema/notification.schema';
import { quest } from '@/database/schema/quest.schema';
import { tag } from '@/database/schema/tag.schema';
import { auth } from '@/modules/auth';
import { createNotification } from '@/modules/notification';

import { randomUUID } from 'node:crypto';

import { eq, inArray } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test';

const hirer = {
  id: randomUUID(),
  email: `noti-hirer-${randomUUID()}@ku.th`,
  firstName: 'Notification',
  lastName: 'Hirer',
};
const worker = {
  id: randomUUID(),
  email: `noti-worker-${randomUUID()}@ku.th`,
  firstName: 'Notification',
  lastName: 'Worker',
};
const secondWorker = {
  id: randomUUID(),
  email: `noti-worker2-${randomUUID()}@ku.th`,
  firstName: 'Second',
  lastName: 'Worker',
};

let postgresAvailable = false;
const tagId = randomUUID();
const createdQuestIds: string[] = [];
const authenticate = () =>
  spyOn(auth.api, 'getSession').mockImplementation((async ({ headers }: { headers: Headers }) => {
    const memberId = headers.get('x-member-id') ?? hirer.id;
    const member = [hirer, worker, secondWorker].find(({ id }) => id === memberId) ?? hirer;
    return { user: member, session: { userId: member.id } } as never;
  }) as never);

const request = (
  path: string,
  method = 'GET',
  memberId = hirer.id,
  headers: HeadersInit = {},
  body?: BodyInit
) =>
  app.handle(
    new Request(`http://localhost${path}`, {
      method,
      headers: {
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...headers,
        'x-member-id': memberId,
      },
      body,
    })
  );

describe('Notification integration', () => {
  beforeAll(async () => {
    try {
      await postgresSql`select 1`;
      postgresAvailable = true;
      await db.insert(authUser).values([hirer, worker, secondWorker]);
      await db.insert(tag).values({ id: tagId, name: 'Notification tag' });
    } catch {
      postgresAvailable = false;
    }
  });

  afterAll(async () => {
    if (!postgresAvailable) return;
    try {
      if (createdQuestIds.length > 0) {
        await db.delete(quest).where(inArray(quest.id, createdQuestIds));
      }
      await db.delete(tag).where(eq(tag.id, tagId));
      await db.delete(authUser).where(inArray(authUser.id, [hirer.id, worker.id, secondWorker.id]));
    } catch {
      // Best-effort teardown.
    }
  });

  beforeEach(() => {
    authenticate();
  });

  afterEach(async () => {
    if (!postgresAvailable) return;
    await db
      .delete(notification)
      .where(inArray(notification.recipientId, [hirer.id, worker.id, secondWorker.id]));
    await db
      .delete(notificationDevice)
      .where(inArray(notificationDevice.memberId, [hirer.id, worker.id, secondWorker.id]));
  });

  it('requires authentication for notification routes', async () => {
    spyOn(auth.api, 'getSession').mockResolvedValue(null as never);
    const res = await app.handle(new Request('http://localhost/api/v2/notifications'));
    expect(res.status).toBe(401);
  });

  it('publishes notifications endpoints in openapi documentation', async () => {
    const res = await app.handle(new Request('http://localhost/openapi/json'));
    const doc = (await res.json()) as {
      paths: Record<string, Record<string, { operationId?: string }>>;
    };
    expect(doc.paths['/api/v2/notifications']?.get?.operationId).toBe('listNotifications');
    expect(doc.paths['/api/v2/notifications/unread-count']?.get?.operationId).toBe(
      'getUnreadNotificationCount'
    );
  });

  it('lists notifications with pagination and unread counts', async () => {
    if (!postgresAvailable) return;

    // Create a mock quest
    const questId = randomUUID();
    createdQuestIds.push(questId);
    await db.insert(quest).values({
      id: questId,
      hirerId: hirer.id,
      apiVersion: 'v2',
      title: 'Help move boxes',
      condition: 'Move all boxes to 3rd floor',
      mode: 'CANDIDATE',
      participation: 'SOLO',
      v2Mode: 'CANDIDATE',
      v2Participation: 'SINGLE',
      tagId,
      questStatus: 'QUEST_OPEN',
      rewardSatang: 10_000,
      startTime: new Date(Date.now() + 100_000),
      dueAt: new Date(Date.now() + 200_000),
    });

    // Create 2 notifications for hirer
    await createNotification({
      recipientId: hirer.id,
      actorId: worker.id,
      category: 'CANDIDATE',
      type: 'CANDIDATE_APPLIED',
      severity: 'info',
      title: 'New Candidate Application',
      message: 'Notification Worker applied to your quest Help move boxes.',
      resourceType: 'QUEST',
      resourceId: questId,
      actionRoute: `/quest/${questId}/manage`,
      actionLabel: 'Review Candidates',
    });

    await createNotification({
      recipientId: hirer.id,
      actorId: secondWorker.id,
      category: 'CANDIDATE',
      type: 'CANDIDATE_APPLIED',
      severity: 'info',
      title: 'New Candidate Application',
      message: 'Second Worker applied to your quest Help move boxes.',
      resourceType: 'QUEST',
      resourceId: questId,
      actionRoute: `/quest/${questId}/manage`,
      actionLabel: 'Review Candidates',
    });

    const res = await request('/api/v2/notifications', 'GET', hirer.id);
    expect(res.status).toBe(200);

    const json = (await res.json()) as {
      success: boolean;
      data: {
        items: Array<{
          id: string;
          title: string;
          message: string;
          actor: { displayName: string };
          quest: { title: string };
          action: { label: string; route: string };
          readAt: string | null;
        }>;
        unreadCount: number;
      };
    };

    expect(json.success).toBe(true);
    expect(json.data.unreadCount).toBe(2);
    expect(json.data.items).toHaveLength(2);
    expect(json.data.items[0]?.title).toBe('New Candidate Application');
    expect(json.data.items[0]?.quest?.title).toBe('Help move boxes');
    expect(json.data.items[0]?.action?.label).toBe('Review Candidates');
    expect(json.data.items[0]?.readAt).toBeNull();
  });

  it('marks a single notification as read and counts correctly', async () => {
    if (!postgresAvailable) return;

    const questId = randomUUID();
    createdQuestIds.push(questId);
    await db.insert(quest).values({
      id: questId,
      hirerId: hirer.id,
      apiVersion: 'v2',
      title: 'Solo test quest',
      condition: 'Condition',
      mode: 'CANDIDATE',
      participation: 'SOLO',
      v2Mode: 'CANDIDATE',
      v2Participation: 'SINGLE',
      tagId,
      questStatus: 'QUEST_OPEN',
      rewardSatang: 10_000,
      startTime: new Date(Date.now() + 100_000),
      dueAt: new Date(Date.now() + 200_000),
    });

    const created = await createNotification({
      recipientId: hirer.id,
      actorId: worker.id,
      category: 'CANDIDATE',
      type: 'CANDIDATE_APPLIED',
      title: 'New Candidate Application',
      message: 'Worker applied',
      resourceType: 'QUEST',
      resourceId: questId,
      actionRoute: `/quest/${questId}/manage`,
      actionLabel: 'Review Candidates',
    });

    // Check count
    const countRes = await request('/api/v2/notifications/unread-count', 'GET', hirer.id);
    expect(countRes.status).toBe(200);
    const countJson = (await countRes.json()) as { data: { unreadCount: number } };
    expect(countJson.data.unreadCount).toBe(1);

    // Mark read
    const readRes = await request(`/api/v2/notifications/${created.id}/read`, 'PATCH', hirer.id);
    expect(readRes.status).toBe(200);
    const readJson = (await readRes.json()) as { data: { id: string; readAt: string } };
    expect(readJson.data.id).toBe(created.id);
    expect(readJson.data.readAt).toBeDefined();

    // Recheck count
    const countAfter = await request('/api/v2/notifications/unread-count', 'GET', hirer.id);
    const countAfterJson = (await countAfter.json()) as { data: { unreadCount: number } };
    expect(countAfterJson.data.unreadCount).toBe(0);
  });

  it('marks all notifications as read', async () => {
    if (!postgresAvailable) return;

    const questId = randomUUID();
    createdQuestIds.push(questId);
    await db.insert(quest).values({
      id: questId,
      hirerId: hirer.id,
      apiVersion: 'v2',
      title: 'Quest test',
      condition: 'Condition',
      mode: 'CANDIDATE',
      participation: 'SOLO',
      v2Mode: 'CANDIDATE',
      v2Participation: 'SINGLE',
      tagId,
      questStatus: 'QUEST_OPEN',
      rewardSatang: 10_000,
      startTime: new Date(Date.now() + 100_000),
      dueAt: new Date(Date.now() + 200_000),
    });

    await createNotification({
      recipientId: hirer.id,
      category: 'QUEST_STATE',
      type: 'QUEST_STARTED',
      title: 'Started',
      message: 'Quest started',
      resourceType: 'QUEST',
      resourceId: questId,
      actionRoute: `/quest/${questId}`,
      actionLabel: 'View',
    });

    const markAllRes = await request('/api/v2/notifications/mark-all-read', 'POST', hirer.id);
    expect(markAllRes.status).toBe(200);
    const markAllJson = (await markAllRes.json()) as { data: { updatedCount: number } };
    expect(markAllJson.data.updatedCount).toBe(1);
  });

  it('registers and unregisters FCM device tokens', async () => {
    if (!postgresAvailable) return;

    const regRes = await request(
      '/api/v2/notifications/devices',
      'POST',
      worker.id,
      {},
      JSON.stringify({ token: 'test-fcm-token-123', platform: 'ANDROID' })
    );
    expect(regRes.status).toBe(200);
    const regJson = (await regRes.json()) as { data: { registered: boolean } };
    expect(regJson.data.registered).toBe(true);

    const unregRes = await request(
      '/api/v2/notifications/devices/test-fcm-token-123',
      'DELETE',
      worker.id
    );
    expect(unregRes.status).toBe(200);
    const unregJson = (await unregRes.json()) as { data: { unregistered: boolean } };
    expect(unregJson.data.unregistered).toBe(true);
  });

  it('triggers notifications when candidate applies and is selected', async () => {
    if (!postgresAvailable) return;

    const questId = randomUUID();
    createdQuestIds.push(questId);
    await db.insert(quest).values({
      id: questId,
      hirerId: hirer.id,
      apiVersion: 'v2',
      title: 'Move boxes to dorm 3',
      condition: 'Move all boxes',
      mode: 'CANDIDATE',
      participation: 'SOLO',
      v2Mode: 'CANDIDATE',
      v2Participation: 'SINGLE',
      tagId,
      questStatus: 'QUEST_OPEN',
      rewardSatang: 10_000,
      startTime: new Date(Date.now() + 100_000),
      dueAt: new Date(Date.now() + 200_000),
    });

    const applyRes = await request(`/api/v2/quests/${questId}/applications`, 'POST', worker.id, {
      'idempotency-key': 'noti-test-apply-1',
    });
    expect(applyRes.status).toBe(200);
    const workerAppId = ((await applyRes.json()) as { data: { id: string } }).data.id;

    const secondApplyRes = await request(
      `/api/v2/quests/${questId}/applications`,
      'POST',
      secondWorker.id,
      { 'idempotency-key': 'noti-test-apply-2' }
    );
    expect(secondApplyRes.status).toBe(200);

    const hirerNotiRes = await request('/api/v2/notifications', 'GET', hirer.id);
    expect(hirerNotiRes.status).toBe(200);
    const hirerNotiJson = (await hirerNotiRes.json()) as {
      data: {
        items: Array<{
          title: string;
          message: string;
          type: string;
          category: string;
          action: { label: string; route: string };
        }>;
      };
    };
    expect(hirerNotiJson.data.items).toHaveLength(2);
    expect(hirerNotiJson.data.items[0]?.type).toBe('CANDIDATE_APPLIED');
    expect(hirerNotiJson.data.items[0]?.category).toBe('CANDIDATE');
    expect(hirerNotiJson.data.items[0]?.title).toBe('New Candidate Application');
    expect(hirerNotiJson.data.items[0]?.action.route).toBe(`/quest/${questId}/manage`);

    const selectRes = await request(
      `/api/v2/quests/${questId}/applications/${workerAppId}/select`,
      'POST',
      hirer.id,
      { 'idempotency-key': 'noti-test-select-1' },
      JSON.stringify({})
    );
    expect(selectRes.status).toBe(200);

    const workerNotiRes = await request('/api/v2/notifications', 'GET', worker.id);
    expect(workerNotiRes.status).toBe(200);
    const workerNotiJson = (await workerNotiRes.json()) as {
      data: {
        items: Array<{
          title: string;
          message: string;
          type: string;
          action: { label: string; route: string };
        }>;
      };
    };
    expect(workerNotiJson.data.items).toHaveLength(1);
    expect(workerNotiJson.data.items[0]?.type).toBe('CANDIDATE_SELECTED');
    expect(workerNotiJson.data.items[0]?.title).toBe('Application Accepted! 🎉');
    expect(workerNotiJson.data.items[0]?.message).toContain('You were selected for');
    expect(workerNotiJson.data.items[0]?.action.route).toBe(`/quest/${questId}/work`);

    const secondWorkerNotiRes = await request('/api/v2/notifications', 'GET', secondWorker.id);
    expect(secondWorkerNotiRes.status).toBe(200);
    const secondWorkerNotiJson = (await secondWorkerNotiRes.json()) as {
      data: {
        items: Array<{
          title: string;
          message: string;
          type: string;
        }>;
      };
    };
    expect(secondWorkerNotiJson.data.items).toHaveLength(1);
    expect(secondWorkerNotiJson.data.items[0]?.type).toBe('CANDIDATE_REJECTED');
    expect(secondWorkerNotiJson.data.items[0]?.title).toBe('Application Update');
  });
});
