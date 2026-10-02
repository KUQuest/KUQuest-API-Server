import { app } from '@/app';
import { db, sql } from '@/database/client';
import { authUser } from '@/database/schema/auth.schema';
import { pushDelivery, pushDevice } from '@/database/schema/push.schema';
import { auth } from '@/modules/auth';
import {
  createPushDeviceEncryption,
  disableAndroidPushDevice,
  enqueuePushDeliveryInTransaction,
  processPendingPushDeliveries,
  registerAndroidPushDevice,
} from '@/modules/push';

import { randomUUID } from 'node:crypto';

import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, mock, spyOn } from 'bun:test';

let postgresAvailable = false;
const memberIds: string[] = [];
const originalEncryptionKey = process.env.PUSH_DEVICE_ENCRYPTION_KEY;
const originalEncryptionKeyVersion = process.env.PUSH_DEVICE_ENCRYPTION_KEY_VERSION;
const encryptionKey = '9f'.repeat(32);
const encryption = createPushDeviceEncryption({ key: encryptionKey, keyVersion: 'test-v1' });

const createMember = async () => {
  const id = randomUUID();
  await db.insert(authUser).values({
    id,
    email: `${id}@push.test`,
    firstName: 'Push',
    lastName: 'Member',
  });
  memberIds.push(id);
  return id;
};

const memberRequest = (
  memberId: string,
  path: string,
  options: RequestInit = {}
): Promise<Response> => {
  spyOn(auth.api, 'getSession').mockImplementation((async () => ({
    user: { id: memberId },
    session: { userId: memberId },
  })) as never);
  return app.handle(
    new Request(`http://localhost${path}`, {
      ...options,
      headers: {
        ...(options.body ? { 'content-type': 'application/json' } : {}),
        ...options.headers,
      },
    })
  );
};

const enqueueDelivery = async (memberId: string, eventKey: string, now: Date) =>
  db.transaction((transaction) =>
    enqueuePushDeliveryInTransaction(transaction, {
      recipientMemberId: memberId,
      eventKey,
      eventType: 'CONDUCT_REPORT_UPHELD',
      title: 'Conduct Report decision',
      body: 'Your Conduct Report was upheld. Reason: not attending the Quest. Result: a 7-day Red Flag.',
      deepLink: 'kuquest://conduct-reports/CND-000001',
      data: { eventType: 'CONDUCT_REPORT_UPHELD', decision: 'UPHELD' },
      now,
    })
  );

beforeAll(async () => {
  try {
    await sql`select 1`;
    postgresAvailable = true;
    process.env.PUSH_DEVICE_ENCRYPTION_KEY = encryptionKey;
    process.env.PUSH_DEVICE_ENCRYPTION_KEY_VERSION = 'test-v1';
  } catch {
    return;
  }
});

afterEach(async () => {
  mock.restore();
  if (!postgresAvailable || memberIds.length === 0) return;
  await db.delete(pushDelivery).where(inArray(pushDelivery.recipientMemberId, memberIds));
  await db.delete(pushDevice).where(inArray(pushDevice.memberId, memberIds));
  await db.delete(authUser).where(inArray(authUser.id, memberIds));
  memberIds.length = 0;
});

afterAll(async () => {
  if (originalEncryptionKey === undefined) delete process.env.PUSH_DEVICE_ENCRYPTION_KEY;
  else process.env.PUSH_DEVICE_ENCRYPTION_KEY = originalEncryptionKey;
  if (originalEncryptionKeyVersion === undefined)
    delete process.env.PUSH_DEVICE_ENCRYPTION_KEY_VERSION;
  else process.env.PUSH_DEVICE_ENCRYPTION_KEY_VERSION = originalEncryptionKeyVersion;
});

describe('Android Push Devices and delivery', () => {
  it('registers, lists, and disables only the authenticated Member Devices', async () => {
    if (!postgresAvailable) return;
    const ownerId = await createMember();
    const otherMemberId = await createMember();
    const token = `fcm-registration-token-${randomUUID()}-android`;

    const first = await memberRequest(ownerId, '/api/v1/push/devices', {
      method: 'POST',
      body: JSON.stringify({ token }),
    });
    expect(first.status).toBe(201);
    const deviceId = (await first.json()).data.device.id as string;

    const repeated = await memberRequest(ownerId, '/api/v1/push/devices', {
      method: 'POST',
      body: JSON.stringify({ token }),
    });
    expect(repeated.status).toBe(201);
    expect((await repeated.json()).data.device.id).toBe(deviceId);

    const [stored] = await db.select().from(pushDevice).where(eq(pushDevice.id, deviceId));
    expect(stored?.tokenHash).not.toBe(token);
    expect(stored?.ciphertext).not.toContain(token);

    const list = await memberRequest(ownerId, '/api/v1/push/devices');
    expect(list.status).toBe(200);
    const listedDevices = (await list.json()).data.devices;
    expect(listedDevices).toEqual([expect.objectContaining({ id: deviceId })]);
    expect(JSON.stringify(listedDevices)).not.toContain(token);

    const otherMemberCannotDisable = await memberRequest(
      otherMemberId,
      `/api/v1/push/devices/${deviceId}`,
      { method: 'DELETE' }
    );
    expect(otherMemberCannotDisable.status).toBe(404);

    const disabled = await memberRequest(ownerId, `/api/v1/push/devices/${deviceId}`, {
      method: 'DELETE',
    });
    expect(disabled.status).toBe(200);
    expect((await disabled.json()).success).toBe(true);
    expect(
      await db
        .select()
        .from(pushDevice)
        .where(and(eq(pushDevice.id, deviceId)))
    ).toEqual([expect.objectContaining({ disabledAt: expect.any(Date) })]);
  });

  it('deduplicates one Event per Member and retries a transient FCM failure', async () => {
    if (!postgresAvailable) return;
    const memberId = await createMember();
    const now = new Date('2026-09-25T01:00:00.000Z');
    const eventKey = `conduct-report-upheld:${randomUUID()}`;
    await registerAndroidPushDevice(memberId, `fcm-token-${randomUUID()}-android`, {
      now,
      encryption,
    });
    await enqueueDelivery(memberId, eventKey, now);
    await enqueueDelivery(memberId, eventKey, now);

    const sends: Array<{ token: string; message: { title: string; body: string; data: object } }> =
      [];
    const retry = await processPendingPushDeliveries({
      now: () => now,
      encryption,
      send: async (token, message) => {
        sends.push({ token, message });
        return { kind: 'RETRYABLE_FAILURE', errorCode: 'FCM_HTTP_503' };
      },
    });
    expect(retry).toBe(1);
    const [pending] = await db
      .select()
      .from(pushDelivery)
      .where(
        and(eq(pushDelivery.recipientMemberId, memberId), eq(pushDelivery.eventKey, eventKey))
      );
    expect(pending).toMatchObject({
      status: 'PUSH_DELIVERY_PENDING',
      attemptCount: 1,
      lastErrorCode: 'FCM_HTTP_503',
    });
    expect(pending?.nextAttemptAt?.getTime()).toBeGreaterThan(now.getTime());
    expect(sends).toHaveLength(1);
    expect(sends[0]?.message).toMatchObject({
      title: 'Conduct Report decision',
      body: expect.stringContaining('not attending the Quest'),
      data: { eventType: 'CONDUCT_REPORT_UPHELD', eventKey },
    });

    const nextAttempt = new Date(pending!.nextAttemptAt!.getTime() + 1);
    const completed = await processPendingPushDeliveries({
      now: () => nextAttempt,
      encryption,
      send: async () => ({ kind: 'DELIVERED' }),
    });
    expect(completed).toBe(1);
    const [delivered] = await db
      .select()
      .from(pushDelivery)
      .where(
        and(eq(pushDelivery.recipientMemberId, memberId), eq(pushDelivery.eventKey, eventKey))
      );
    expect(delivered).toMatchObject({
      status: 'PUSH_DELIVERY_DELIVERED',
      attemptCount: 2,
      deliveredAt: expect.any(Date),
    });
  });

  it('fails an expired final attempt lease instead of leaving the delivery pending', async () => {
    if (!postgresAvailable) return;
    const memberId = await createMember();
    const now = new Date('2026-09-25T03:00:00.000Z');
    const eventKey = `conduct-report-upheld:${randomUUID()}`;
    await registerAndroidPushDevice(memberId, `fcm-token-${randomUUID()}-android`, {
      now,
      encryption,
    });
    await enqueueDelivery(memberId, eventKey, now);
    await db
      .update(pushDelivery)
      .set({ attemptCount: 8, nextAttemptAt: new Date(now.getTime() - 1) })
      .where(
        and(eq(pushDelivery.recipientMemberId, memberId), eq(pushDelivery.eventKey, eventKey))
      );

    let sendCalled = false;
    const processed = await processPendingPushDeliveries({
      now: () => now,
      encryption,
      send: async () => {
        sendCalled = true;
        return { kind: 'DELIVERED' };
      },
    });

    expect(processed).toBe(0);
    expect(sendCalled).toBe(false);
    const [delivery] = await db
      .select()
      .from(pushDelivery)
      .where(
        and(eq(pushDelivery.recipientMemberId, memberId), eq(pushDelivery.eventKey, eventKey))
      );
    expect(delivery).toMatchObject({
      status: 'PUSH_DELIVERY_FAILED',
      attemptCount: 8,
      nextAttemptAt: null,
      lastErrorCode: 'PUSH_MAX_ATTEMPTS_REACHED',
    });
  });

  it('disables an invalid FCM destination and records a disabled delivery', async () => {
    if (!postgresAvailable) return;
    const memberId = await createMember();
    const now = new Date('2026-09-25T02:00:00.000Z');
    const eventKey = `conduct-report-upheld:${randomUUID()}`;
    const device = await registerAndroidPushDevice(memberId, `fcm-token-${randomUUID()}-android`, {
      now,
      encryption,
    });
    await enqueueDelivery(memberId, eventKey, now);

    const processed = await processPendingPushDeliveries({
      now: () => now,
      encryption,
      send: async () => ({ kind: 'INVALID_DESTINATION', errorCode: 'UNREGISTERED' }),
    });
    expect(processed).toBe(1);
    const [delivery] = await db
      .select()
      .from(pushDelivery)
      .where(
        and(eq(pushDelivery.recipientMemberId, memberId), eq(pushDelivery.eventKey, eventKey))
      );
    expect(delivery?.status).toBe('PUSH_DELIVERY_DISABLED');
    expect(await disableAndroidPushDevice(memberId, device.id, now)).toBe(false);
    const [storedDevice] = await db.select().from(pushDevice).where(eq(pushDevice.id, device.id));
    expect(storedDevice?.disabledAt).toEqual(now);
  });
});
