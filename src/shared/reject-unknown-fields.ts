import { ValidationError } from 'elysia';
import type { TSchema } from 'elysia';

type ObjectSchema = TSchema & { properties: Record<string, TSchema> };

const isInvalidBody = (body: unknown, editableFields: Set<string>): boolean => {
  if (body === undefined || body === null) return false;

  if (typeof body !== 'object' || Array.isArray(body)) return true;

  return Object.keys(body).some((field) => !editableFields.has(field));
};

export const rejectUnknownFields = (schema: ObjectSchema) => {
  const editableFields = new Set(Object.keys(schema.properties));

  return ({ body }: { body: unknown }) => {
    if (isInvalidBody(body, editableFields)) {
      throw new ValidationError('body', schema, body);
    }
  };
};
