import { t } from 'elysia';

export const pushDeviceParamsSchema = t.Object({
  deviceId: t.String({ format: 'uuid' }),
});

export const registerPushDeviceSchema = t.Object(
  {
    token: t.String({ minLength: 20, maxLength: 4_096 }),
  },
  { additionalProperties: false }
);

const pushDeviceSchema = t.Object({
  id: t.String({ format: 'uuid' }),
  registeredAt: t.String({ format: 'date-time' }),
  lastSeenAt: t.String({ format: 'date-time' }),
});

export const pushDeviceListResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({ devices: t.Array(pushDeviceSchema) }),
});

export const pushDeviceResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({ device: pushDeviceSchema }),
});
