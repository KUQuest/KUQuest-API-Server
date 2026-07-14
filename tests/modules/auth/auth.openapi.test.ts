import { describe, expect, it } from 'bun:test';

import { app } from '@/app';

type OpenAPIDocument = {
  tags?: Array<{ name?: string }>;
  paths?: Record<
    string,
    Record<
      string,
      {
        responses?: Record<
          string,
          {
            content?: Record<
              string,
              { schema?: { properties?: Record<string, unknown> } }
            >;
          }
        >;
      }
    >
  >;
  components?: {
    securitySchemes?: Record<string, unknown>;
    schemas?: Record<string, unknown>;
  };
};

const getOpenAPIDocument = async (): Promise<OpenAPIDocument> => {
  const response = await app.handle(
    new Request('http://localhost/openapi/json'),
  );

  expect(response.status).toBe(200);

  return response.json();
};

describe('authentication OpenAPI documentation', () => {
  it('documents the auth endpoints without removing existing paths', async () => {
    const document = await getOpenAPIDocument();

    expect(document.paths?.['/']).toBeDefined();
    expect(document.paths?.['/health']).toBeDefined();
    expect(document.paths?.['/api/auth/sign-in/social']?.post).toBeDefined();
    expect(document.paths?.['/api/auth/callback/google']?.get).toBeDefined();
    expect(document.paths?.['/api/auth/get-session']?.get).toBeDefined();
    expect(document.paths?.['/api/auth/sign-out']?.post).toBeDefined();
    expect(document.paths?.['/v1/wallet']?.get).toBeDefined();
    expect(document.paths?.['/v1/wallet/policy']?.get).toBeDefined();
    expect(document.paths?.['/v1/wallet/activities']?.get).toBeDefined();
    expect(
      document.paths?.['/v1/wallet/earnings-conversions']?.post,
    ).toBeDefined();
  });

  it('defines the auth tag, session security, and reusable schemas', async () => {
    const document = await getOpenAPIDocument();

    expect(document.tags?.some((tag) => tag.name === 'Auth')).toBe(true);
    expect(
      document.components?.securitySchemes?.betterAuthSession,
    ).toBeDefined();
    expect(document.components?.schemas?.AuthUser).toBeDefined();
    expect(document.components?.schemas?.AuthSessionResponse).toBeDefined();
    expect(document.components?.schemas?.AuthError).toBeDefined();
    expect(document.components?.schemas?.ApiFailure).toBeDefined();
    expect(document.components?.schemas?.ApiError).toBeDefined();
    expect(document.components?.schemas?.ValidationIssue).toBeDefined();
  });

  it('documents the universal first-party success envelope', async () => {
    const document = await getOpenAPIDocument();
    const healthOperation = document.paths?.['/health']?.get;
    const properties =
      healthOperation?.responses?.['200']?.content?.['application/json']?.schema
        ?.properties;

    expect(properties?.success).toBeDefined();
    expect(properties?.data).toBeDefined();
    expect(properties?.error).toBeDefined();
    expect(properties?.trace_id).toBeDefined();
  });
});
