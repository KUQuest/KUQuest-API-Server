import { randomUUID } from 'node:crypto';

import { and, desc, eq, gt, isNull } from 'drizzle-orm';

import { db as defaultDb } from '@/database/client';
import {
  developmentActorSessions,
  developmentTestUsers,
  user,
} from '@/database/schema';

import type {
  DevelopmentActorSession,
  DevelopmentTestRepository,
  DevelopmentTestUser,
  DevelopmentUserSummary,
} from './dev-test.types';

type Database = typeof defaultDb;

const userSummary = (row: {
  id: string;
  email: string;
  name: string;
  firstName: string;
  lastName: string;
}): DevelopmentUserSummary => ({
  id: row.id,
  user_id: row.id,
  email: row.email,
  name: row.name,
  first_name: row.firstName,
  last_name: row.lastName,
});

const testUser = (row: {
  id: string;
  email: string;
  name: string;
  firstName: string;
  lastName: string;
  createdByUserId: string;
  createdAt: Date;
}): DevelopmentTestUser => ({
  ...userSummary(row),
  created_by_user_id: row.createdByUserId,
  created_at: row.createdAt.toISOString(),
});

const testUserSelection = {
  id: user.id,
  email: user.email,
  name: user.name,
  firstName: user.firstName,
  lastName: user.lastName,
  createdByUserId: developmentTestUsers.createdByUserId,
  createdAt: developmentTestUsers.createdAt,
};

export class PostgresDevelopmentTestRepository
  implements DevelopmentTestRepository
{
  constructor(private readonly database: Database = defaultDb) {}

  async getRealUser(userId: string): Promise<DevelopmentUserSummary | null> {
    const [row] = await this.database
      .select({
        id: user.id,
        email: user.email,
        name: user.name,
        firstName: user.firstName,
        lastName: user.lastName,
      })
      .from(user)
      .leftJoin(
        developmentTestUsers,
        eq(developmentTestUsers.userId, user.id),
      )
      .where(and(eq(user.id, userId), isNull(developmentTestUsers.userId)))
      .limit(1);
    return row ? userSummary(row) : null;
  }

  async listTestUsers(): Promise<DevelopmentTestUser[]> {
    const rows = await this.database
      .select(testUserSelection)
      .from(developmentTestUsers)
      .innerJoin(user, eq(user.id, developmentTestUsers.userId))
      .orderBy(desc(developmentTestUsers.createdAt));
    return rows.map(testUser);
  }

  async createTestUser(input: {
    createdByUserId: string;
    displayName?: string;
    firstName: string;
    lastName: string;
  }): Promise<DevelopmentTestUser> {
    const id = randomUUID();
    const email = `test+${id}@ku.th`;
    const name =
      input.displayName ?? `${input.firstName} ${input.lastName}`.trim();

    return this.database.transaction(async (tx) => {
      await tx.insert(user).values({
        id,
        email,
        name,
        firstName: input.firstName,
        lastName: input.lastName,
        emailVerified: true,
      });
      const [marker] = await tx
        .insert(developmentTestUsers)
        .values({ userId: id, createdByUserId: input.createdByUserId })
        .returning({
          createdByUserId: developmentTestUsers.createdByUserId,
          createdAt: developmentTestUsers.createdAt,
        });
      if (!marker) throw new Error('Development test user was not created.');

      return testUser({
        id,
        email,
        name,
        firstName: input.firstName,
        lastName: input.lastName,
        ...marker,
      });
    });
  }

  async createActorSession(input: {
    tokenHash: string;
    userId: string;
    activatedByUserId: string;
    expiresAt: Date;
  }): Promise<DevelopmentActorSession | null> {
    const [actor] = await this.database
      .select(testUserSelection)
      .from(developmentTestUsers)
      .innerJoin(user, eq(user.id, developmentTestUsers.userId))
      .where(eq(developmentTestUsers.userId, input.userId))
      .limit(1);
    if (!actor) return null;

    await this.database.insert(developmentActorSessions).values(input);
    return { actor: testUser(actor), expires_at: input.expiresAt.toISOString() };
  }

  async resolveActorSession(input: {
    tokenHash: string;
    activatedByUserId: string;
    now: Date;
  }): Promise<DevelopmentActorSession | null> {
    const [row] = await this.database
      .select({
        ...testUserSelection,
        expiresAt: developmentActorSessions.expiresAt,
      })
      .from(developmentActorSessions)
      .innerJoin(
        developmentTestUsers,
        eq(developmentTestUsers.userId, developmentActorSessions.userId),
      )
      .innerJoin(user, eq(user.id, developmentActorSessions.userId))
      .where(
        and(
          eq(developmentActorSessions.tokenHash, input.tokenHash),
          eq(
            developmentActorSessions.activatedByUserId,
            input.activatedByUserId,
          ),
          gt(developmentActorSessions.expiresAt, input.now),
        ),
      )
      .limit(1);
    return row
      ? { actor: testUser(row), expires_at: row.expiresAt.toISOString() }
      : null;
  }

  async deleteActorSession(input: {
    tokenHash: string;
    activatedByUserId: string;
  }): Promise<void> {
    await this.database
      .delete(developmentActorSessions)
      .where(
        and(
          eq(developmentActorSessions.tokenHash, input.tokenHash),
          eq(
            developmentActorSessions.activatedByUserId,
            input.activatedByUserId,
          ),
        ),
      );
  }
}
