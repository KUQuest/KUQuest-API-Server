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

type ErrorCode = 400 | 401 | 404 | 413 | 415 | 502;

export const responses = <T>(success: T, ...errorCodes: ErrorCode[]) => {
    const response: Record<number, T | typeof apiErrorSchema> = { 200: success };
    for (const code of errorCodes) response[code] = apiErrorSchema;
    return response;
};
