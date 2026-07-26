import { Elysia, ValidationError } from 'elysia';

import { profileUpdateSchema } from './profile.schema';

const editableFields = new Set(Object.keys(profileUpdateSchema.properties));

// Elysia strips body properties the schema does not declare rather than rejecting
// them, and coerces a body it cannot read as an object into an empty one. Either way a
// request that writes a field this endpoint does not own would look like it succeeded.
// `normalize: false` fixes the first case but only from the root application, where it
// would change every other module's behaviour too.
const isRejectable = (body: unknown) => {
  if (body === undefined || body === null) return false;

  if (typeof body !== 'object' || Array.isArray(body)) return true;

  return Object.keys(body).some((field) => !editableFields.has(field));
};

export const profileBodyGuard = new Elysia({ name: 'profile-body-guard' })
  // Transform is the last point at which a body property the schema does not declare
  // is still visible. Raising Elysia's own validation error makes the rejection
  // indistinguishable from every other rejected body, including status and error code.
  .onTransform({ as: 'scoped' }, ({ body }) => {
    if (isRejectable(body)) throw new ValidationError('body', profileUpdateSchema, body);
  });
