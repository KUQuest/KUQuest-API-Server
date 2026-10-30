import { db, sql } from '@/database/client';
import { authUser } from '@/database/schema/auth.schema';
import { memberNotification } from '@/database/schema/notification.schema';
import { pushDelivery } from '@/database/schema/push.schema';
import { recordMemberNotificationInTransaction } from '@/modules/notification';

import { randomUUID } from 'node:crypto';

import { eq, inArray } from 'drizzle-orm';
import { afterEach, beforeAll, describe, expect, it } from 'bun:test';

let postgresAvailable = false;
const memberIds: string[] = [];

const createMember = async () => {
  const id = randomUUID();
  await db.insert(authUser).values({
    id,
    email: `${id}@notification.test`,
    firstName: 'Notification',
    lastName: 'Member',
  });
  memberIds.push(id);
  return id;
};

const record = (
  memberId: string,
  eventKey: string,
  overrides: Partial<Parameters<typeof recordMemberNotificationInTransaction>[1]> = {}
) =>
  db.transaction((transaction) =>
    recordMemberNotificationInTransaction(transaction, {
      memberId,
      type: 'PENALTY_BAN_APPLIED',
      eventKey,
      result: 'TEMPORARY_BAN',
      ladder: 'MISCONDUCT',
      source: 'REPORT_CASE',
      transitionId: eventKey,
      expiresAt: new Date('2030-01-08T00:00:00.000Z'),
      now: new Date('2030-01-01T00:00:00.000Z'),
      ...overrides,
    })
  );

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

describe('recordMemberNotificationInTransaction', () => {
  it('records once and queues one data-only Push, even when replayed', async () => {
    if (!postgresAvailable) return;
    const memberId = await createMember();
    const eventKey = `penalty:${randomUUID()}`;

    const first = await record(memberId, eventKey);
    const replay = await record(memberId, eventKey);

    expect(first.created).toBe(true);
    expect(replay).toEqual({ notificationId: first.notificationId, created: false });
    const rows = await db
      .select()
      .from(memberNotification)
      .where(eq(memberNotification.memberId, memberId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: 'PENALTY_BAN_APPLIED',
      questId: null,
      readAt: null,
      result: 'TEMPORARY_BAN',
    });
    const deliveries = await db
      .select()
      .from(pushDelivery)
      .where(eq(pushDelivery.recipientMemberId, memberId));
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.eventType).toBe('PENALTY_BAN_APPLIED');
    expect(deliveries[0]?.data).toEqual({
      type: 'PENALTY_BAN_APPLIED',
      notificationId: first.notificationId,
      transitionId: eventKey,
      result: 'TEMPORARY_BAN',
      ladder: 'MISCONDUCT',
      source: 'REPORT_CASE',
      expiresAt: '2030-01-08T00:00:00.000Z',
    });
  });

  it('omits expiresAt for a permanent ban and needs no questId', async () => {
    if (!postgresAvailable) return;
    const memberId = await createMember();

    const { notificationId } = await record(memberId, `penalty:${randomUUID()}`, {
      result: 'PERMANENT_BAN',
      ladder: 'REVIEW',
      source: 'REVIEW_AVERAGE',
    });

    const [row] = await db
      .select()
      .from(memberNotification)
      .where(eq(memberNotification.id, notificationId));
    expect(row?.expiresAt).toBeNull();
    expect(row?.questId).toBeNull();
    const [delivery] = await db
      .select()
      .from(pushDelivery)
      .where(eq(pushDelivery.recipientMemberId, memberId));
    expect(delivery?.data).not.toHaveProperty('expiresAt');
    expect(delivery?.data).not.toHaveProperty('questId');
    expect(delivery?.data.result).toBe('PERMANENT_BAN');
  });

  it('rolls back the inbox row with the caller transaction', async () => {
    if (!postgresAvailable) return;
    const memberId = await createMember();
    await db
      .transaction(async (transaction) => {
        await recordMemberNotificationInTransaction(transaction, {
          memberId,
          type: 'PENALTY_RED_FLAG_APPLIED',
          eventKey: `penalty:${randomUUID()}`,
          now: new Date(),
        });
        throw new Error('rollback');
      })
      .catch(() => undefined);

    expect(
      await db.select().from(memberNotification).where(eq(memberNotification.memberId, memberId))
    ).toHaveLength(0);
  });
});
