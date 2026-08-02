import { ValidationError } from 'elysia';

import { portfolioUpdateSchema } from './portfolio.schema';

const editableFields = new Set(Object.keys(portfolioUpdateSchema.properties));

const isUnacceptableUpdateBody = (body: unknown) => {
  if (body === undefined || body === null) return false;

  if (typeof body !== 'object' || Array.isArray(body)) return true;

  return Object.keys(body).some((field) => !editableFields.has(field));
};

export const rejectUnknownPortfolioFields = ({ body }: { body: unknown }) => {
  if (isUnacceptableUpdateBody(body)) {
    throw new ValidationError('body', portfolioUpdateSchema, body);
  }
};
