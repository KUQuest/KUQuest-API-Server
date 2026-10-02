import { ElysiaCustomStatusResponse, StatusMap } from 'elysia';

const requests = new WeakMap<Request, { id: string; startedAt: number; clientTraceId?: string }>();
const traceIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const logCodePattern = /^[A-Z][A-Z0-9_]{0,63}$/;

export const startRequestLog = ({
  request,
  set,
}: {
  request: Request;
  set: { headers: Record<string, string | number | undefined> };
}) => {
  const id = crypto.randomUUID();
  const clientTraceId =
    request.headers.get('upgrade')?.toLowerCase() === 'websocket'
      ? new URL(request.url).searchParams.get('traceId')
      : null;
  requests.set(request, {
    id,
    startedAt: performance.now(),
    ...(clientTraceId && traceIdPattern.test(clientTraceId) ? { clientTraceId } : {}),
  });
  set.headers['X-Request-ID'] = id;
};

export const getRequestLogId = (request: Request) => requests.get(request)?.id;

export const finishRequestLog = ({
  request,
  route,
  response,
  set,
}: {
  request: Request;
  route?: string;
  response: unknown;
  set: { status?: number | keyof typeof StatusMap };
}) => {
  if (
    request.headers.get('upgrade')?.toLowerCase() === 'websocket' &&
    response === undefined &&
    (set.status === undefined || set.status === 200)
  )
    return;

  const state = requests.get(request);
  if (!state) return;
  requests.delete(request);
  const body = response instanceof ElysiaCustomStatusResponse ? response.response : response;
  const status =
    response instanceof Response
      ? response.status
      : response instanceof ElysiaCustomStatusResponse
        ? response.code
        : typeof set.status === 'string'
          ? StatusMap[set.status]
          : (set.status ?? 200);
  const errorCode =
    typeof body === 'object' &&
    body !== null &&
    'success' in body &&
    body.success === false &&
    'error' in body &&
    typeof body.error === 'object' &&
    body.error !== null &&
    'code' in body.error &&
    typeof body.error.code === 'string' &&
    logCodePattern.test(body.error.code)
      ? body.error.code
      : undefined;

  const entry = JSON.stringify({
    time: new Date().toISOString(),
    event: 'http.request',
    requestId: state.id,
    ...(state.clientTraceId ? { clientTraceId: state.clientTraceId } : {}),
    method: request.method,
    route: route ?? 'unmatched',
    status,
    durationMs: Math.round((performance.now() - state.startedAt) * 100) / 100,
    ...(errorCode ? { errorCode } : {}),
  });
  if (status >= 500) console.error(entry);
  else console.log(entry);
};

type Socket = { data: { request: Request; route: string } };
type SocketEvent = 'open' | 'subscribed' | 'received' | 'send' | 'rejected' | 'close';

export const logSocket = (
  ws: Socket,
  event: SocketEvent,
  detail?: { type?: string; code?: number | string }
) => {
  const state = requests.get(ws.data.request);
  if (!state) return;
  const type = detail?.type && logCodePattern.test(detail.type) ? detail.type : undefined;
  const code =
    typeof detail?.code === 'number'
      ? Number.isInteger(detail.code) && detail.code >= 1000 && detail.code <= 4999
        ? detail.code
        : undefined
      : typeof detail?.code === 'string' && logCodePattern.test(detail.code)
        ? detail.code
        : undefined;
  const entry = JSON.stringify({
    time: new Date().toISOString(),
    event: `ws.${event}`,
    requestId: state.id,
    ...(state.clientTraceId ? { clientTraceId: state.clientTraceId } : {}),
    route: ws.data.route,
    ...(type ? { type } : {}),
    ...(code !== undefined ? { code } : {}),
    ...(event === 'close'
      ? { durationMs: Math.round((performance.now() - state.startedAt) * 100) / 100 }
      : {}),
  });
  if (event === 'close') requests.delete(ws.data.request);
  console.log(entry);
};
