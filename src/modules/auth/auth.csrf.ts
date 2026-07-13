export class CsrfError extends Error {
  readonly status = 403;
  readonly code = 'FORBIDDEN' as const;

  constructor(message: string) {
    super(message);
    this.name = 'CsrfError';
  }
}

const normalizedOrigin = (value: string): string => {
  try {
    return new URL(value).origin;
  } catch {
    return '';
  }
};

export const assertTrustedBrowserOrigin = (
  headers: Headers,
  trustedOrigins: readonly string[],
): void => {
  if (headers.get('sec-fetch-site') === 'cross-site') {
    throw new CsrfError('Cross-site requests are not allowed.');
  }

  const requestOrigin = headers.get('origin') ?? headers.get('referer');
  const allowed = new Set(trustedOrigins.map(normalizedOrigin).filter(Boolean));
  if (!requestOrigin || !allowed.has(normalizedOrigin(requestOrigin))) {
    throw new CsrfError('The request origin is not trusted.');
  }
};
