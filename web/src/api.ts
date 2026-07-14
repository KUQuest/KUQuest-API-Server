export interface RequestLog {
  time: string;
  method: string;
  path: string;
  status: number;
  duration_ms: number;
  trace_id?: string;
  request?: unknown;
  response?: unknown;
}

const sensitiveKey = /(authorization|cookie|secret|token|account_number|qr_string|raw|payload|callback|credential)/i;

const sanitize = (value: unknown, key = ''): unknown => {
  if (sensitiveKey.test(key)) return '[REDACTED]';
  if (Array.isArray(value)) return value.map((item) => sanitize(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, sanitize(item, name)]));
  }
  return typeof value === 'string' && value.length > 500 ? `${value.slice(0, 500)}…` : value;
};

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly traceId?: string,
  ) {
    super(message);
  }
}

export const idempotencyKey = (kind: string) => `${kind}-${crypto.randomUUID()}`;

export const createApi = (onLog: (entry: RequestLog) => void) => async <T>(
  path: string,
  options: RequestInit = {},
): Promise<T> => {
  const started = performance.now();
  const method = options.method ?? 'GET';
  const headers = new Headers(options.headers);
  if (options.body !== undefined && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  let response: Response | undefined;
  let body: unknown;
  try {
    response = await fetch(path, { ...options, headers, credentials: 'include' });
    body = await response.json().catch(() => null);
    const envelope = body as { success?: boolean; data?: T; error?: { detail?: string; message?: string; code?: string }; trace_id?: string } | null;
    onLog(sanitize({
      time: new Date().toISOString(), method, path, status: response.status,
      duration_ms: Math.round(performance.now() - started), trace_id: envelope?.trace_id,
      request: typeof options.body === 'string' ? JSON.parse(options.body) : undefined,
      response: body,
    }) as RequestLog);
    if (!response.ok || envelope?.success === false) {
      throw new ApiError(
        envelope?.error?.detail ?? envelope?.error?.message ?? `Request failed (${response.status})`,
        response.status,
        envelope?.error?.code,
        envelope?.trace_id,
      );
    }
    return (envelope && 'success' in envelope ? envelope.data : body) as T;
  } catch (error) {
    if (!response) {
      onLog({ time: new Date().toISOString(), method, path, status: 0,
        duration_ms: Math.round(performance.now() - started), response: { network_error: String(error) } });
    }
    throw error;
  }
};
