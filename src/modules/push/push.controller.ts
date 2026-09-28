import { apiError, apiSuccess } from '@/shared/api-response';
import type { AuthenticatedSession } from '@/modules/auth';

import type { Static } from 'elysia';
import type { StatusMap } from 'elysia/utils';

import {
  disableAndroidPushDevice,
  listAndroidPushDevices,
  PushServiceError,
  registerAndroidPushDevice,
} from './push.service';
import type { pushDeviceParamsSchema, registerPushDeviceSchema } from './push.schema';

type PushContext = {
  session: AuthenticatedSession;
  set: { status?: number | keyof StatusMap };
};

export const listPushDevicesController = async ({ session }: PushContext) =>
  apiSuccess({
    devices: (await listAndroidPushDevices(session.user.id)).map((device) => ({
      id: device.id,
      registeredAt: device.registeredAt.toISOString(),
      lastSeenAt: device.lastSeenAt.toISOString(),
    })),
  });

export const registerPushDeviceController = async ({
  session,
  body,
  set,
}: PushContext & { body: Static<typeof registerPushDeviceSchema> }) => {
  try {
    const device = await registerAndroidPushDevice(session.user.id, body.token);
    set.status = 201;
    return apiSuccess({
      device: {
        id: device.id,
        registeredAt: device.registeredAt.toISOString(),
        lastSeenAt: device.lastSeenAt.toISOString(),
      },
    });
  } catch (error) {
    if (!(error instanceof PushServiceError)) throw error;
    set.status = error.code === 'PUSH_ENCRYPTION_UNAVAILABLE' ? 503 : 400;
    return apiError(error.code, error.message);
  }
};

export const disablePushDeviceController = async ({
  session,
  params,
  set,
}: PushContext & { params: Static<typeof pushDeviceParamsSchema> }) => {
  const disabled = await disableAndroidPushDevice(session.user.id, params.deviceId);
  if (!disabled) {
    set.status = 404;
    return apiError('PUSH_DEVICE_NOT_FOUND', 'Android Push Device does not exist.');
  }
  return apiSuccess();
};
