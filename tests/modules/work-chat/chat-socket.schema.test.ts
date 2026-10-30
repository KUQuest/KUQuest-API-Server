import {
  extractChatSocketClientMessageId,
  parseChatSocketSendMessage,
} from '@/modules/work-chat/chat-socket.schema';

import { describe, expect, it } from 'bun:test';

describe('chat socket SEND_MESSAGE parser', () => {
  const command = {
    type: 'SEND_MESSAGE' as const,
    clientMessageId: 'client-message-1',
    text: 'Hello from the socket',
  };

  it('accepts a valid command object', () => {
    expect(parseChatSocketSendMessage(command)).toEqual(command);
  });

  it('accepts a JSON text payload', () => {
    expect(parseChatSocketSendMessage(JSON.stringify(command))).toEqual(command);
  });

  it('accepts a binary payload', () => {
    const payload = new TextEncoder().encode(JSON.stringify(command));

    expect(parseChatSocketSendMessage(payload)).toEqual(command);
  });

  it('rejects malformed and unsupported commands', () => {
    expect(parseChatSocketSendMessage('{"type":"SEND_MESSAGE"')).toBeNull();
    expect(
      parseChatSocketSendMessage({
        ...command,
        type: 'DELETE_MESSAGE',
      })
    ).toBeNull();
    expect(parseChatSocketSendMessage({ ...command, unexpected: true })).toBeNull();
  });

  it('extracts clientMessageId from decoded payloads', () => {
    expect(extractChatSocketClientMessageId(JSON.stringify(command))).toBe('client-message-1');
    expect(extractChatSocketClientMessageId({ clientMessageId: 'client-message-2' })).toBe(
      'client-message-2'
    );
    expect(extractChatSocketClientMessageId({ clientMessageId: '   ' })).toBeNull();
    expect(extractChatSocketClientMessageId('not-json')).toBeNull();
  });
});
