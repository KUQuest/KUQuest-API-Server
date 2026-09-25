import { db, sql } from '@/database/client';
import { authUser } from '@/database/schema/auth.schema';
import { closeSocketForActiveMemberBan } from '@/modules/auth';

import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'bun:test';

describe('chat socket Member Ban policy', () => {
  it('closes a banned Member socket and leaves an allowed Member socket open', async () => {
    await sql`select 1`;
    const memberId = randomUUID();
    const closeCalls: Array<{ code: number; reason: string }> = [];
    const socket = {
      close: (code: number, reason: string) => closeCalls.push({ code, reason }),
    };

    await db.insert(authUser).values({
      id: memberId,
      email: `${memberId}@ku.th`,
      firstName: 'Socket',
      lastName: 'Member',
      bannedUntil: new Date(Date.now() + 60_000),
    });

    try {
      expect(await closeSocketForActiveMemberBan(socket, memberId)).toBe(true);
      expect(closeCalls).toEqual([{ code: 4403, reason: 'Member Ban is active' }]);

      await db.update(authUser).set({ bannedUntil: null }).where(eq(authUser.id, memberId));
      expect(await closeSocketForActiveMemberBan(socket, memberId)).toBe(false);
      expect(closeCalls).toHaveLength(1);
    } finally {
      await db.delete(authUser).where(eq(authUser.id, memberId));
    }
  });
});
