import { createHash, randomBytes } from 'node:crypto';
import { createConnection, type Socket } from 'node:net';

type WebSocketFrame = { opcode: number; payload: Buffer };
type FrameWaiter = {
  resolve: (frame: WebSocketFrame | undefined) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class QuestWebSocketClient {
  private buffer: Buffer;
  private readonly frames: WebSocketFrame[] = [];
  private readonly waiters: FrameWaiter[] = [];

  private constructor(
    private readonly socket: Socket,
    initialData: Buffer
  ) {
    this.buffer = initialData;
    socket.on('data', (chunk) => {
      this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
      this.readAvailableFrames();
    });
    socket.on('error', () => undefined);
    socket.on('close', () => {
      for (const waiter of this.waiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.resolve(undefined);
      }
    });
    this.readAvailableFrames();
  }

  static async connect(
    port: number,
    questId: string,
    cookie: string,
    origin: string | null = 'http://localhost:5000'
  ) {
    const socket = createConnection({ host: '127.0.0.1', port });
    const key = randomBytes(16).toString('base64');

    return new Promise<QuestWebSocketClient>((resolve, reject) => {
      let received = Buffer.alloc(0);
      const timeout = setTimeout(() => fail(new Error('WebSocket handshake timed out')), 5_000);
      const fail = (error: Error) => {
        clearTimeout(timeout);
        socket.destroy();
        reject(error);
      };
      const onError = (error: Error) => fail(error);
      const onData = (chunk: Buffer) => {
        received = Buffer.concat([received, chunk]);
        const boundary = received.indexOf('\r\n\r\n');
        if (boundary < 0) return;

        const header = received.subarray(0, boundary).toString('latin1');
        const status = header.split('\r\n', 1)[0];
        if (!status?.includes(' 101 ')) {
          fail(new Error(`WebSocket handshake rejected: ${status ?? 'invalid response'}`));
          return;
        }

        const accept = header.match(/^sec-websocket-accept:\s*(\S+)/im)?.[1];
        const expected = createHash('sha1')
          .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
          .digest('base64');
        if (accept !== expected) {
          fail(new Error('WebSocket handshake accept key did not match'));
          return;
        }

        clearTimeout(timeout);
        socket.off('error', onError);
        socket.off('data', onData);
        resolve(new QuestWebSocketClient(socket, received.subarray(boundary + 4)));
      };

      socket.on('error', onError);
      socket.on('data', onData);
      socket.on('connect', () => {
        socket.write(
          [
            `GET /api/v2/quests/${questId}/events HTTP/1.1`,
            `Host: 127.0.0.1:${port}`,
            'Upgrade: websocket',
            'Connection: Upgrade',
            `Sec-WebSocket-Key: ${key}`,
            'Sec-WebSocket-Version: 13',
            ...(origin ? [`Origin: ${origin}`] : []),
            `Cookie: ${cookie}`,
            '',
            '',
          ].join('\r\n')
        );
      });
    });
  }

  private readAvailableFrames() {
    while (this.buffer.length >= 2) {
      const opcode = this.buffer[0]! & 0x0f;
      const masked = (this.buffer[1]! & 0x80) !== 0;
      let payloadLength = this.buffer[1]! & 0x7f;
      let headerLength = 2;

      if (payloadLength === 126) {
        if (this.buffer.length < 4) return;
        payloadLength = this.buffer.readUInt16BE(2);
        headerLength = 4;
      } else if (payloadLength === 127) {
        if (this.buffer.length < 10) return;
        payloadLength = Number(this.buffer.readBigUInt64BE(2));
        headerLength = 10;
      }

      const maskLength = masked ? 4 : 0;
      const payloadStart = headerLength + maskLength;
      const frameLength = payloadStart + payloadLength;
      if (this.buffer.length < frameLength) return;

      const payload = Buffer.from(this.buffer.subarray(payloadStart, frameLength));
      if (masked) {
        const mask = this.buffer.subarray(headerLength, payloadStart);
        for (let index = 0; index < payload.length; index += 1) {
          payload[index] = payload[index]! ^ mask[index % 4]!;
        }
      }
      this.buffer = this.buffer.subarray(frameLength);

      const frame = { opcode, payload };
      const waiter = this.waiters.shift();
      if (waiter) {
        clearTimeout(waiter.timer);
        waiter.resolve(frame);
      } else {
        this.frames.push(frame);
      }
    }
  }

  private readFrame(timeoutMs: number) {
    const frame = this.frames.shift();
    if (frame) return Promise.resolve(frame);

    return new Promise<WebSocketFrame | undefined>((resolve) => {
      const waiter: FrameWaiter = {
        resolve,
        timer: setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          resolve(undefined);
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  async nextFrame(timeoutMs = 5_000): Promise<WebSocketFrame | undefined> {
    let frame = await this.readFrame(timeoutMs);
    while (frame?.opcode === 9) {
      this.writeClientFrame(10, frame.payload);
      frame = await this.readFrame(timeoutMs);
    }
    return frame;
  }

  async nextText(timeoutMs = 5_000) {
    const frame = await this.nextFrame(timeoutMs);
    return frame?.opcode === 1 ? frame.payload.toString() : undefined;
  }

  sendText(message: string) {
    this.writeClientFrame(1, Buffer.from(message));
  }

  private writeClientFrame(opcode: number, payload: Buffer) {
    if (payload.length > 125) throw new Error('Test WebSocket frames must fit one short frame');
    const mask = randomBytes(4);
    const frame = Buffer.alloc(2 + mask.length + payload.length);
    frame[0] = 0x80 | opcode;
    frame[1] = 0x80 | payload.length;
    mask.copy(frame, 2);
    for (let index = 0; index < payload.length; index += 1) {
      frame[index + 6] = payload[index]! ^ mask[index % 4]!;
    }
    this.socket.write(frame);
  }

  destroy() {
    this.socket.destroy();
  }
}
