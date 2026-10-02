import { corsPlugin } from '@/plugins/cors';
import { errorHandlerPlugin } from '@/plugins/error-handler';
import { apiError } from '@/shared/api-response';
import { finishRequestLog, logSocket, startRequestLog } from '@/shared/request-log';

import { expect, spyOn, test } from 'bun:test';
import { Elysia } from 'elysia';

const readEntries = (lines: string[]) => lines.map((line) => JSON.parse(line));

test('HTTP logs correlate safe route and response details, including native responses', async () => {
  const lines: string[] = [];
  const recorded = Promise.withResolvers<void>();
  const record = (value: unknown) => {
    lines.push(String(value));
    if (lines.length === 3) recorded.resolve();
  };
  const output = spyOn(console, 'log').mockImplementation(record);
  const errors = spyOn(console, 'error').mockImplementation(record);
  try {
    const app = new Elysia()
      .onRequest(startRequestLog)
      .onAfterResponse(finishRequestLog)
      .use(corsPlugin)
      .get('/items/:itemId', () => 'ok')
      .post('/items/:itemId', ({ set }) => {
        set.status = 400;
        return apiError('INVALID_ITEM', 'Do not log this message');
      })
      .mount('/api/auth/*', () => new Response('denied', { status: 401 }));

    const origin = 'http://localhost:3000';
    const success = await app.handle(
      new Request('http://localhost/items/private-id?secret=top-secret', {
        headers: { Origin: origin },
      })
    );
    const failure = await app.handle(
      new Request('http://localhost/items/private-id?secret=top-secret', {
        method: 'POST',
        headers: { Origin: origin },
      })
    );
    const mounted = await app.handle(new Request('http://localhost/api/auth/get-session'));
    await recorded.promise;

    const entries = readEntries(lines);
    expect(entries).toHaveLength(3);
    expect(entries.map(({ status }) => status)).toEqual([200, 400, 401]);
    expect(entries.map(({ route }) => route)).toEqual([
      '/items/:itemId',
      '/items/:itemId',
      '/api/auth/*',
    ]);
    expect(entries[1].errorCode).toBe('INVALID_ITEM');
    expect(entries[0].requestId).toBe(success.headers.get('X-Request-ID'));
    expect(entries[1].requestId).toBe(failure.headers.get('X-Request-ID'));
    expect(entries[2].requestId).toBe(mounted.headers.get('X-Request-ID'));
    expect(success.headers.get('Access-Control-Expose-Headers')).toContain('X-Request-ID');
    expect(entries.every(({ durationMs }) => durationMs >= 0)).toBe(true);
    expect(lines.join(' ')).not.toMatch(/private-id|top-secret|Do not log this message/);
  } finally {
    output.mockRestore();
    errors.mockRestore();
  }
});

test('unhandled errors keep one request ID without logging exception messages', async () => {
  const lines: string[] = [];
  const recorded = Promise.withResolvers<void>();
  const errors = spyOn(console, 'error').mockImplementation((value) => {
    const line = String(value);
    lines.push(line);
    if (JSON.parse(line).event === 'http.request') recorded.resolve();
  });
  try {
    const app = new Elysia()
      .onRequest(startRequestLog)
      .onAfterResponse(finishRequestLog)
      .use(errorHandlerPlugin)
      .get('/api/v2/broken', () => {
        const error = new Error('private exception detail');
        error.name = 'private-person-secret';
        throw error;
      });
    const response = await app.handle(new Request('http://localhost/api/v2/broken'));
    await recorded.promise;

    const entries = readEntries(lines);
    expect(response.status).toBe(500);
    expect(entries.map(({ event }) => event)).toEqual(['request.exception', 'http.request']);
    expect(entries[0].requestId).toBe(response.headers.get('X-Request-ID'));
    expect(entries[1].requestId).toBe(response.headers.get('X-Request-ID'));
    expect(entries[0].errorName).toBe('Error');
    expect(entries[1].status).toBe(500);
    expect(lines.join(' ')).not.toMatch(/private exception detail|private-person-secret/);
  } finally {
    errors.mockRestore();
  }
});

test('rejected WebSocket handshakes keep the frontend trace ID', async () => {
  const recorded = Promise.withResolvers<string>();
  const output = spyOn(console, 'log').mockImplementation((value) =>
    recorded.resolve(String(value))
  );
  try {
    const app = new Elysia()
      .onRequest(startRequestLog)
      .onAfterResponse(finishRequestLog)
      .onBeforeHandle(({ set }) => {
        set.status = 401;
        return new Response(null, { status: 401 });
      })
      .ws('/protected', { open() {} });
    const traceId = crypto.randomUUID();
    const response = await app.handle(
      new Request(`http://localhost/protected?traceId=${traceId}&secret=private-token`, {
        headers: { Upgrade: 'websocket' },
      })
    );
    const line = await recorded.promise;
    const entry = JSON.parse(line);
    expect(response.status).toBe(401);
    expect(entry).toMatchObject({
      event: 'http.request',
      route: '/protected',
      status: 401,
      clientTraceId: traceId,
      requestId: response.headers.get('X-Request-ID'),
    });
    expect(line).not.toContain('private-token');
  } finally {
    output.mockRestore();
  }
});

test('WebSocket logs one connection across frames without storing payloads or invalid trace IDs', async () => {
  const lines: string[] = [];
  let closeRecorded = Promise.withResolvers<void>();
  const output = spyOn(console, 'log').mockImplementation((value) => {
    const line = String(value);
    lines.push(line);
    if (JSON.parse(line).event === 'ws.close') closeRecorded.resolve();
  });
  const traceId = crypto.randomUUID();
  const app = new Elysia()
    .onRequest(startRequestLog)
    .onAfterResponse(finishRequestLog)
    .ws('/chat/:conversationId', {
      open(ws) {
        logSocket(ws, 'open');
        ws.send('ready');
        logSocket(ws, 'subscribed');
      },
      message(ws) {
        logSocket(ws, 'received', { type: 'SEND_MESSAGE' });
        ws.send('accepted');
        logSocket(ws, 'send', { type: 'MESSAGE_ACCEPTED' });
      },
      close(ws, code) {
        logSocket(ws, 'close', { code });
      },
    })
    .listen({ hostname: '127.0.0.1', port: 0 });
  try {
    const socket = new WebSocket(
      `ws://127.0.0.1:${app.server!.port}/chat/private-conversation?traceId=${traceId}&token=private-token`
    );
    await new Promise<void>((resolve, reject) => {
      socket.onerror = () => reject(new Error('WebSocket connection failed'));
      socket.onmessage = ({ data }) => {
        if (data === 'ready') socket.send('private-message-text');
        else socket.close(1000);
      };
      socket.onclose = () => resolve();
    });
    await closeRecorded.promise;
    const entries = readEntries(lines);
    expect(entries.map(({ event }) => event)).toEqual([
      'ws.open',
      'ws.subscribed',
      'ws.received',
      'ws.send',
      'ws.close',
    ]);
    expect(entries.every(({ requestId }) => requestId === entries[0].requestId)).toBe(true);
    expect(entries.every(({ clientTraceId }) => clientTraceId === traceId)).toBe(true);
    expect(entries[4].code).toBe(1000);
    expect(entries[4].durationMs).toBeGreaterThanOrEqual(0);
    expect(lines.join(' ')).not.toMatch(/private-conversation|private-token|private-message-text/);

    lines.length = 0;
    closeRecorded = Promise.withResolvers<void>();
    const invalid = new WebSocket(
      `ws://127.0.0.1:${app.server!.port}/chat/other?traceId=not-a-uuid`
    );
    await new Promise<void>((resolve, reject) => {
      invalid.onerror = () => reject(new Error('WebSocket connection failed'));
      invalid.onmessage = () => invalid.close();
      invalid.onclose = () => resolve();
    });
    await closeRecorded.promise;
    expect(readEntries(lines).every((entry) => !('clientTraceId' in entry))).toBe(true);
  } finally {
    await app.stop();
    output.mockRestore();
  }
});
