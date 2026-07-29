import { ValidationError } from 'elysia';

import { profileUpdateSchema } from './profile.schema';

const editableFields = new Set(Object.keys(profileUpdateSchema.properties));

// Elysia strips body properties the schema does not declare rather than rejecting
// them, and coerces a body it cannot read as an object into an empty one. Either way a
// request that writes a field this endpoint does not own would look like it succeeded.
// `normalize: false` fixes the first case but only from the root application, where it
// would change every other module's behaviour too.
const isUnacceptableUpdateBody = (body: unknown) => {
  if (body === undefined || body === null) return false;

  if (typeof body !== 'object' || Array.isArray(body)) return true;

  return Object.keys(body).some((field) => !editableFields.has(field));
};

/**
 * Runs as the profile update's transform, the last point at which a body property the
 * schema does not declare is still visible. Raising Elysia's own validation error makes
 * the rejection indistinguishable from every other rejected body, status and code alike.
 */
export const rejectUnknownProfileFields = ({ body }: { body: unknown }) => {
  if (isUnacceptableUpdateBody(body)) {
    throw new ValidationError('body', profileUpdateSchema, body);
  }
};
