import { t } from 'elysia';

// The counterpart to apiErrorSchema for endpoints that report success without data.
export const apiSuccessSchema = t.Object({
    success: t.Literal(true),
});

export const apiErrorSchema = t.Object({
    success: t.Literal(false),
    error: t.Object({
        code: t.String(),
        message: t.String(),
    }),
});

export const betterAuthSecurity = [{ betterAuthSession: [] }];

type ErrorCode = 400 | 401 | 403 | 404 | 409 | 413 | 415 | 500 | 502 | 503;
type ResponseOptions = { successStatus?: 200 | 202 };

export const responses = <T>(
  success: T,
  ...items: Array<ErrorCode | ResponseOptions>
) => {
  const options = items.find((item): item is ResponseOptions => typeof item === 'object');
  const response: Record<number, T | typeof apiErrorSchema> = {
    [options?.successStatus ?? 200]: success,
  };
  for (const item of items) {
    if (typeof item === 'number') response[item] = apiErrorSchema;
  }
  return response;
};
