import { t, type TSchema } from 'elysia';

export interface ValidationIssue {
  path: string;
  message: string;
}

export interface ApiError {
  type: string;
  title: string;
  status: number;
  code: string;
  detail: string;
  issues: ValidationIssue[];
}

export interface ApiSuccess<T> {
  success: true;
  data: T;
  error: null;
  trace_id: string;
}

export interface ApiFailure {
  success: false;
  data: null;
  error: ApiError;
  trace_id: string;
}

export const validationIssueSchema = t.Object({
  path: t.String({
    description: 'JSON Pointer-like path to the invalid request value.',
    examples: ['/amount'],
  }),
  message: t.String({
    description: 'Human-readable guidance for correcting this value.',
  }),
});

export const apiErrorSchema = t.Object({
  type: t.String({
    format: 'uri',
    description: 'Stable URI identifying the problem type.',
  }),
  title: t.String({
    description: 'Stable, human-readable summary of the problem type.',
  }),
  status: t.Integer({
    minimum: 400,
    maximum: 599,
    description: 'HTTP status code also returned on the response.',
  }),
  code: t.String({
    description: 'Stable machine-readable application error code.',
    examples: ['VALIDATION_FAILED'],
  }),
  detail: t.String({
    description: 'Safe, occurrence-specific explanation for the user.',
  }),
  issues: t.Array(validationIssueSchema, {
    description: 'Field-level validation issues; empty for non-validation errors.',
  }),
});

export const apiFailureSchema = t.Object({
  success: t.Literal(false),
  data: t.Null(),
  error: apiErrorSchema,
  trace_id: t.String({
    description: 'Request correlation identifier for logs and support.',
  }),
});

export const apiSuccessSchema = <T extends TSchema>(dataSchema: T) =>
  t.Object({
    success: t.Literal(true),
    data: dataSchema,
    error: t.Null(),
    trace_id: t.String({
      description: 'Request correlation identifier for logs and support.',
    }),
  });

export const traceIdFor = (request: Request): string =>
  request.headers.get('x-trace-id') ?? crypto.randomUUID();

export const apiSuccess = <T>(data: T, request: Request): ApiSuccess<T> => ({
  success: true,
  data,
  error: null,
  trace_id: traceIdFor(request),
});

const problemType = (code: string): string =>
  `https://api.kuquest.app/problems/${code.toLowerCase().replaceAll('_', '-')}`;

const problemTitle = (code: string): string =>
  code
    .toLowerCase()
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');

export const apiFailure = (
  status: number,
  code: string,
  detail: string,
  request: Request,
  issues: ValidationIssue[] = [],
): ApiFailure => ({
  success: false,
  data: null,
  error: {
    type: problemType(code),
    title: problemTitle(code),
    status,
    code,
    detail,
    issues,
  },
  trace_id: traceIdFor(request),
});
