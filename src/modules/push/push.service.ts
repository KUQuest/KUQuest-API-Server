import { db } from '@/database/client';
import { pushDelivery, pushDevice, type PushDeliveryStatus } from '@/database/schema/push.schema';

import {
  and,
  asc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lte,
  notExists,
  or,
  sql,
} from 'drizzle-orm';

import {
  createPushDeviceEncryption,
  hashPushDeviceToken,
  PushDeviceEncryptionError,
  type EncryptedPushDeviceToken,
} from './push-device.crypto';
import {
  createFcmPushProvider,
  isFcmPushConfigured,
  type AndroidPushMessage,
  type AndroidPushResult,
} from './push-fcm.service';

export type PushTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type PushDeviceSummary = {
  id: string;
  registeredAt: Date;
  lastSeenAt: Date;
};

export type EnqueuePushDeliveryInput = {
  recipientMemberId: string;
  eventKey: string;
  eventType: string;
  title: string;
  body: string;
  deepLink: string;
  data: Record<string, string>;
  now: Date;
};

type DeviceEncryption = ReturnType<typeof createPushDeviceEncryption>;
type PushSender = (token: string, message: AndroidPushMessage) => Promise<AndroidPushResult>;

const maxDeliveryAttempts = 8;
const deliveryLeaseMs = 2 * 60 * 1_000;
const retryBaseMs = 15 * 1_000;
const retryMaxMs = 15 * 60 * 1_000;
const batchSize = 20;

const fcmProvider = createFcmPushProvider();

export class PushServiceError extends Error {
  readonly code: 'PUSH_DEVICE_NOT_FOUND' | 'PUSH_ENCRYPTION_UNAVAILABLE' | 'PUSH_TOKEN_INVALID';

  constructor(code: PushServiceError['code'], message: string) {
    super(message);
    this.name = 'PushServiceError';
    this.code = code;
  }
}

export const registerAndroidPushDevice = async (
  memberId: string,
  rawToken: string,
  options: { now?: Date; encryption?: DeviceEncryption } = {}
): Promise<PushDeviceSummary> => {
  const token = rawToken.trim();
  if (token.length < 20 || token.length > 4_096) {
    throw new PushServiceError('PUSH_TOKEN_INVALID', 'Android Push token is invalid.');
  }

  const now = options.now ?? new Date();
  let encryptedToken: EncryptedPushDeviceToken;
  try {
    encryptedToken = (options.encryption ?? createPushDeviceEncryption()).encrypt(token);
  } catch (error) {
    if (error instanceof PushDeviceEncryptionError) {
      throw new PushServiceError('PUSH_ENCRYPTION_UNAVAILABLE', error.message);
    }
    throw error;
  }

  const [device] = await db
    .insert(pushDevice)
    .values({
      memberId,
      tokenHash: hashPushDeviceToken(token),
      keyVersion: encryptedToken.keyVersion,
      nonce: encryptedToken.nonce,
      ciphertext: encryptedToken.ciphertext,
      authTag: encryptedToken.authTag,
      registeredAt: now,
      lastSeenAt: now,
      disabledAt: null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: pushDevice.tokenHash,
      set: {
        memberId,
        keyVersion: encryptedToken.keyVersion,
        nonce: encryptedToken.nonce,
        ciphertext: encryptedToken.ciphertext,
        authTag: encryptedToken.authTag,
        registeredAt: now,
        lastSeenAt: now,
        disabledAt: null,
        updatedAt: now,
      },
    })
    .returning({
      id: pushDevice.id,
      registeredAt: pushDevice.registeredAt,
      lastSeenAt: pushDevice.lastSeenAt,
    });
  if (!device) throw new Error('Android Push Device could not be registered.');
  return device;
};

export const listAndroidPushDevices = async (memberId: string): Promise<PushDeviceSummary[]> =>
  db
    .select({
      id: pushDevice.id,
      registeredAt: pushDevice.registeredAt,
      lastSeenAt: pushDevice.lastSeenAt,
    })
    .from(pushDevice)
    .where(and(eq(pushDevice.memberId, memberId), isNull(pushDevice.disabledAt)))
    .orderBy(asc(pushDevice.registeredAt), asc(pushDevice.id));

export const disableAndroidPushDevice = async (
  memberId: string,
  deviceId: string,
  now = new Date()
): Promise<boolean> => {
  const [device] = await db
    .update(pushDevice)
    .set({ disabledAt: now, updatedAt: now })
    .where(
      and(
        eq(pushDevice.id, deviceId),
        eq(pushDevice.memberId, memberId),
        isNull(pushDevice.disabledAt)
      )
    )
    .returning({ id: pushDevice.id });
  return device !== undefined;
};

export const enqueuePushDeliveryInTransaction = async (
  transaction: PushTransaction,
  input: EnqueuePushDeliveryInput
) =>
  transaction
    .insert(pushDelivery)
    .values({
      recipientMemberId: input.recipientMemberId,
      eventKey: input.eventKey,
      eventType: input.eventType,
      title: input.title,
      body: input.body,
      deepLink: input.deepLink,
      data: input.data,
      status: 'PUSH_DELIVERY_PENDING',
      createdAt: input.now,
      updatedAt: input.now,
    })
    .onConflictDoNothing({
      target: [pushDelivery.recipientMemberId, pushDelivery.eventKey],
    });

const claimPendingPushDeliveries = async (now: Date) =>
  db.transaction(async (transaction) => {
    const candidates = await transaction
      .select({ id: pushDelivery.id })
      .from(pushDelivery)
      .where(
        and(
          eq(pushDelivery.status, 'PUSH_DELIVERY_PENDING'),
          or(isNull(pushDelivery.nextAttemptAt), lte(pushDelivery.nextAttemptAt, now)),
          lte(pushDelivery.attemptCount, maxDeliveryAttempts - 1)
        )
      )
      .orderBy(asc(pushDelivery.createdAt), asc(pushDelivery.id))
      .limit(batchSize)
      .for('update', { skipLocked: true });
    if (candidates.length === 0) return [];

    const ids = candidates.map((candidate) => candidate.id);
    return transaction
      .update(pushDelivery)
      .set({
        attemptCount: sql`${pushDelivery.attemptCount} + 1`,
        lastAttemptAt: now,
        nextAttemptAt: new Date(now.getTime() + deliveryLeaseMs),
        updatedAt: now,
      })
      .where(inArray(pushDelivery.id, ids))
      .returning();
  });

const disableDeliveriesWithoutDevices = async (now: Date) => {
  const activeDevice = db
    .select({ id: pushDevice.id })
    .from(pushDevice)
    .where(
      and(eq(pushDevice.memberId, pushDelivery.recipientMemberId), isNull(pushDevice.disabledAt))
    );
  await db
    .update(pushDelivery)
    .set({
      status: 'PUSH_DELIVERY_DISABLED',
      nextAttemptAt: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(pushDelivery.status, 'PUSH_DELIVERY_PENDING'),
        or(isNull(pushDelivery.nextAttemptAt), lte(pushDelivery.nextAttemptAt, now)),
        notExists(activeDevice)
      )
    );
};

const failExpiredPushDeliveryAttempts = async (now: Date) =>
  db
    .update(pushDelivery)
    .set({
      status: 'PUSH_DELIVERY_FAILED',
      nextAttemptAt: null,
      lastErrorCode: 'PUSH_MAX_ATTEMPTS_REACHED',
      updatedAt: now,
    })
    .where(
      and(
        eq(pushDelivery.status, 'PUSH_DELIVERY_PENDING'),
        gte(pushDelivery.attemptCount, maxDeliveryAttempts),
        isNotNull(pushDelivery.nextAttemptAt),
        lte(pushDelivery.nextAttemptAt, now)
      )
    );

const retryTime = (attemptCount: number, now: Date) =>
  new Date(now.getTime() + Math.min(retryBaseMs * 2 ** Math.max(0, attemptCount - 1), retryMaxMs));

const updateDelivery = async (
  deliveryId: string,
  status: PushDeliveryStatus,
  input: { now: Date; nextAttemptAt?: Date | null; deliveredAt?: Date | null; errorCode?: string }
) =>
  db
    .update(pushDelivery)
    .set({
      status,
      nextAttemptAt: input.nextAttemptAt ?? null,
      deliveredAt: input.deliveredAt ?? null,
      lastErrorCode: input.errorCode ?? null,
      updatedAt: input.now,
    })
    .where(eq(pushDelivery.id, deliveryId));

const disableDevices = async (deviceIds: string[], now: Date) => {
  if (deviceIds.length === 0) return;
  await db
    .update(pushDevice)
    .set({ disabledAt: now, updatedAt: now })
    .where(inArray(pushDevice.id, deviceIds));
};

const deliverOne = async (
  delivery: typeof pushDelivery.$inferSelect,
  dependencies: {
    now: () => Date;
    send: PushSender;
    encryption: DeviceEncryption;
  }
) => {
  const attemptTime = dependencies.now();
  const devices = await db
    .select()
    .from(pushDevice)
    .where(and(eq(pushDevice.memberId, delivery.recipientMemberId), isNull(pushDevice.disabledAt)));

  if (devices.length === 0) {
    await updateDelivery(delivery.id, 'PUSH_DELIVERY_DISABLED', { now: attemptTime });
    return;
  }

  const invalidDeviceIds: string[] = [];
  const results = await Promise.all(
    devices.map(async (device) => {
      let token: string;
      try {
        token = dependencies.encryption.decrypt({
          keyVersion: device.keyVersion,
          nonce: device.nonce,
          ciphertext: device.ciphertext,
          authTag: device.authTag,
        });
      } catch (error) {
        if (error instanceof PushDeviceEncryptionError) {
          throw new PushServiceError('PUSH_ENCRYPTION_UNAVAILABLE', error.message);
        }
        throw error;
      }

      const message: AndroidPushMessage = {
        title: delivery.title,
        body: delivery.body,
        deepLink: delivery.deepLink,
        data: { ...delivery.data, eventKey: delivery.eventKey },
      };
      const result = await dependencies.send(token, message);
      if (result.kind === 'INVALID_DESTINATION') invalidDeviceIds.push(device.id);
      return result;
    })
  );
  await disableDevices(invalidDeviceIds, attemptTime);

  if (results.some((result) => result.kind === 'DELIVERED')) {
    await updateDelivery(delivery.id, 'PUSH_DELIVERY_DELIVERED', {
      now: attemptTime,
      deliveredAt: attemptTime,
    });
    return;
  }

  const retryable = results.find((result) => result.kind === 'RETRYABLE_FAILURE');
  if (retryable && delivery.attemptCount < maxDeliveryAttempts) {
    await updateDelivery(delivery.id, 'PUSH_DELIVERY_PENDING', {
      now: attemptTime,
      nextAttemptAt: retryTime(delivery.attemptCount, attemptTime),
      errorCode: retryable.errorCode,
    });
    return;
  }

  if (results.every((result) => result.kind === 'INVALID_DESTINATION')) {
    await updateDelivery(delivery.id, 'PUSH_DELIVERY_DISABLED', { now: attemptTime });
    return;
  }

  const failure = results.find((result) => result.kind === 'PERMANENT_FAILURE');
  await updateDelivery(delivery.id, 'PUSH_DELIVERY_FAILED', {
    now: attemptTime,
    errorCode: failure?.errorCode ?? retryable?.errorCode ?? 'PUSH_MAX_ATTEMPTS_REACHED',
  });
};

export const processPendingPushDeliveries = async (
  options: {
    now?: () => Date;
    send?: PushSender;
    encryption?: DeviceEncryption;
  } = {}
): Promise<number> => {
  const send = options.send ?? fcmProvider.send;
  const now = options.now ?? (() => new Date());
  const nowAtStart = now();
  await disableDeliveriesWithoutDevices(nowAtStart);
  await failExpiredPushDeliveryAttempts(nowAtStart);
  if (!options.send && !isFcmPushConfigured()) return 0;

  let encryption: DeviceEncryption;
  try {
    encryption = options.encryption ?? createPushDeviceEncryption();
  } catch (error) {
    if (error instanceof PushDeviceEncryptionError) return 0;
    throw error;
  }

  const deliveries = await claimPendingPushDeliveries(now());
  await Promise.all(
    deliveries.map((delivery) =>
      deliverOne(delivery, { now, send, encryption }).catch(async (error: unknown) => {
        const failedAt = now();
        const errorCode =
          error instanceof PushServiceError ? error.code : 'PUSH_DELIVERY_WORKER_ERROR';
        const retry = delivery.attemptCount < maxDeliveryAttempts;
        await updateDelivery(
          delivery.id,
          retry ? 'PUSH_DELIVERY_PENDING' : 'PUSH_DELIVERY_FAILED',
          {
            now: failedAt,
            nextAttemptAt: retry ? retryTime(delivery.attemptCount, failedAt) : null,
            errorCode,
          }
        );
      })
    )
  );
  return deliveries.length;
};
