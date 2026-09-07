export type WorkChatDeliveryMessage = {
  id: string;
  conversationId: string;
  sequence: number;
  kind: 'USER' | 'SYSTEM';
  sender: { id: string | null; displayName: string };
  text: string | null;
  attachments: Array<{
    id: string;
    fileName: string;
    mediaType: string;
    sizeBytes: number;
    createdAt: Date;
  }>;
  systemType: string | null;
  systemPayload: Record<string, unknown> | null;
  eventId: string | null;
  createdAt: Date;
};

export type WorkChatCommittedEvent = {
  message: WorkChatDeliveryMessage;
  recipientMemberIds: readonly string[];
};

export type WorkChatDeliverySubscriber = (event: WorkChatCommittedEvent) => void | Promise<void>;

type Subscriber = {
  memberId: string;
  conversationId?: string;
  deliver: WorkChatDeliverySubscriber;
  deliveredEventIds: Set<string>;
};

export type WorkChatDelivery = {
  subscribe(memberId: string, deliver: WorkChatDeliverySubscriber, conversationId?: string): () => void;
  publish(event: WorkChatCommittedEvent): Promise<void>;
};

export const createWorkChatDelivery = (): WorkChatDelivery => {
  const subscribers = new Map<string, Subscriber>();

  return {
    subscribe(memberId, deliver, conversationId) {
      const subscriberId = crypto.randomUUID();
      subscribers.set(subscriberId, {
        memberId,
        conversationId,
        deliver,
        deliveredEventIds: new Set(),
      });
      return () => subscribers.delete(subscriberId);
    },
    async publish(event) {
      const recipientMemberIds = new Set(event.recipientMemberIds);
      const eventId = event.message.eventId ?? event.message.id;
      await Promise.all([...subscribers.entries()].map(async ([subscriberId, subscriber]) => {
        if (
          !recipientMemberIds.has(subscriber.memberId)
          || (subscriber.conversationId !== undefined && subscriber.conversationId !== event.message.conversationId)
          || subscriber.deliveredEventIds.has(eventId)
        ) return;
        try {
          await subscriber.deliver(event);
          subscriber.deliveredEventIds.add(eventId);
        } catch (error) {
          console.error('[work-chat-delivery] Delivery failed', {
            conversationId: event.message.conversationId,
            messageId: event.message.id,
            subscriberId,
            error,
          });
        }
      }));
    },
  };
};

export const workChatDelivery = createWorkChatDelivery();
