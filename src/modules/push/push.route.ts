import { authGuard, memberBanGuard } from '@/modules/auth';
import { apiSuccessSchema, betterAuthSecurity, responses } from '@/shared/api-response.schema';
import { API_V1_PREFIX } from '@/shared/api-version';
import { rejectUnknownFields } from '@/shared/reject-unknown-fields';

import { Elysia } from 'elysia';

import {
  disablePushDeviceController,
  listPushDevicesController,
  registerPushDeviceController,
} from './push.controller';
import {
  pushDeviceListResponseSchema,
  pushDeviceParamsSchema,
  pushDeviceResponseSchema,
  registerPushDeviceSchema,
} from './push.schema';

export const pushRoute = new Elysia({
  name: 'push-route',
  prefix: `${API_V1_PREFIX}/push`,
})
  .use(authGuard)
  .use(memberBanGuard)
  .get('/devices', listPushDevicesController, {
    response: responses(pushDeviceListResponseSchema, 401, 403),
    detail: {
      tags: ['Push'],
      summary: 'List Android Push Devices',
      description: 'Lists the authenticated Member Android Push Devices without device tokens.',
      operationId: 'listAndroidPushDevices',
      security: betterAuthSecurity,
    },
  })
  .post('/devices', registerPushDeviceController, {
    body: registerPushDeviceSchema,
    transform: rejectUnknownFields(registerPushDeviceSchema),
    response: responses(pushDeviceResponseSchema, 400, 401, 403, 503, { successStatus: 201 }),
    detail: {
      tags: ['Push'],
      summary: 'Register an Android Push Device',
      description:
        'Stores an Android FCM token for the authenticated Member after Android notification permission is granted.',
      operationId: 'registerAndroidPushDevice',
      security: betterAuthSecurity,
    },
  })
  .delete('/devices/:deviceId', disablePushDeviceController, {
    params: pushDeviceParamsSchema,
    response: responses(apiSuccessSchema, 401, 403, 404),
    detail: {
      tags: ['Push'],
      summary: 'Disable an Android Push Device',
      description: 'Stops Push delivery to an Android Device owned by the authenticated Member.',
      operationId: 'disableAndroidPushDevice',
      security: betterAuthSecurity,
    },
  });
