import {
  createWorkChatDelivery,
  type WorkChatCommittedEvent,
} from '@/modules/work-chat/work-chat.delivery';

import { describe, expect, it } from 'bun:test';

const event = (id = 'message-1'): WorkChatCommittedEvent => ({
  message: {
    id,
    conversationId: 'conversation-1',
    sequence: 1,
    kind: 'USER',
    sender: { id: 'sender-1', displayName: 'Sender' },
    text: 'Committed Message',
    attachments: [],
    systemType: null,
    systemPayload: null,
    eventId: null,
    createdAt: new Date('2030-01-01T10:00:00.000Z'),
  },
  recipientMemberIds: ['recipient-1'],
});

describe('Work Chat committed delivery', () => {
  it('delivers only to a subscribed current recipient and deduplicates replayed Events', async () => {
    const delivery = createWorkChatDelivery();
    const received: string[] = [];
    delivery.subscribe('recipient-1', ({ message }) => {
      received.push(message.id);
    });
    delivery.subscribe('sender-1', ({ message }) => {
      received.push(`sender:${message.id}`);
    });

    await delivery.publish(event());
    await delivery.publish(event());

    expect(received).toEqual(['message-1']);
  });

  it('allows a failed delivery to retry without creating a duplicate successful delivery', async () => {
    const delivery = createWorkChatDelivery();
    let attempts = 0;
    const received: string[] = [];
    delivery.subscribe('recipient-1', ({ message }) => {
      attempts += 1;
      if (attempts === 1) throw new Error('temporary delivery failure');
      received.push(message.id);
    });

    await delivery.publish(event('message-2'));
    await delivery.publish(event('message-2'));

    expect(attempts).toBe(2);
    expect(received).toEqual(['message-2']);
  });
});
