import type { ElysiaOpenAPIConfig } from '@elysia/openapi';

type OpenAPIDocumentation = NonNullable<
  ElysiaOpenAPIConfig['documentation']
>;
type OpenAPIComponents = NonNullable<OpenAPIDocumentation['components']>;

export const apiResponseOpenAPIComponents = {
  schemas: {
    ValidationIssue: {
      type: 'object',
      required: ['path', 'message'],
      properties: {
        path: {
          type: 'string',
          example: '/amount',
          description: 'JSON Pointer-like path to the invalid request value.',
        },
        message: {
          type: 'string',
          description: 'Human-readable guidance for correcting this value.',
        },
      },
    },
    ApiError: {
      type: 'object',
      required: ['type', 'title', 'status', 'code', 'detail', 'issues'],
      properties: {
        type: { type: 'string', format: 'uri' },
        title: { type: 'string' },
        status: { type: 'integer', minimum: 400, maximum: 599 },
        code: { type: 'string', example: 'VALIDATION_FAILED' },
        detail: { type: 'string' },
        issues: {
          type: 'array',
          items: { $ref: '#/components/schemas/ValidationIssue' },
        },
      },
    },
    ApiFailure: {
      type: 'object',
      required: ['success', 'data', 'error', 'trace_id'],
      properties: {
        success: { type: 'boolean', enum: [false] },
        data: { nullable: true, enum: [null] },
        error: { $ref: '#/components/schemas/ApiError' },
        trace_id: { type: 'string' },
      },
    },
  },
} satisfies OpenAPIComponents;
