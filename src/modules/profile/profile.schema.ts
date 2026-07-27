import { t } from 'elysia';

export const avatarUploadSchema = t.Object(
  {
    avatar: t.File(),
  },
  {
    additionalProperties: false,
  },
);

export const avatarUploadResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({
    fileId: t.String({ format: 'uuid' }),
  }),
});
