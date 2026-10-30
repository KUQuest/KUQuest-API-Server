import { db } from '@/database/client';
import type { PushTransaction } from '@/modules/push/push.service';

import { sql } from 'drizzle-orm';

/** Postgres channel for Member inbox invalidations. The hub listens on it. */
export const notificationEventsChannel = 'kuquest_notification_events';

/**
 * Tells the open inbox sockets of one Member to reload the inbox from REST.
 *
 * With a transaction, `pg_notify` waits for that transaction to commit. A rolled-back
 * transaction sends nothing. Without a transaction, the signal goes at once.
 */
export const publishNotificationsChanged = async (
  memberId: string,
  transaction?: PushTransaction
): Promise<void> => {
  await (transaction ?? db).execute(
    sql`select pg_notify(${notificationEventsChannel}, ${JSON.stringify({ memberId })})`
  );
};
