import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { user } from './auth.schema';

const domainTime = (name: string) => timestamp(name, { withTimezone: true });

export const roles = pgTable('roles', {
  id: uuid('id').defaultRandom().primaryKey(),
  code: text('code').notNull().unique(),
  description: text('description').notNull(),
  createdAt: domainTime('created_at').defaultNow().notNull(),
});

export const userRoleAssignments = pgTable('user_role_assignments', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: text('user_id').notNull().references(() => user.id),
  roleId: uuid('role_id').notNull().references(() => roles.id),
  grantedByUserId: text('granted_by_user_id').references(() => user.id),
  grantedAt: domainTime('granted_at').defaultNow().notNull(),
  revokedByUserId: text('revoked_by_user_id').references(() => user.id),
  revokedAt: domainTime('revoked_at'),
  reason: text('reason'),
}, (t) => [
  uniqueIndex('user_role_assignments_active_uidx').on(t.userId, t.roleId).where(sql`${t.revokedAt} is null`),
  index('user_role_assignments_user_idx').on(t.userId),
  check('user_role_assignments_revoke_pair_chk', sql`(${t.revokedAt} is null) = (${t.revokedByUserId} is null)`),
]);
