import { relations, sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { major } from './academic.schema';
import { file } from './file.schema';

export const authUser = pgTable(
  'auth_user',
  {
    id: text('id').primaryKey(),
    email: text('email').notNull(),
    emailVerified: boolean('email_verified').default(false).notNull(),
    // better-auth's core `image` field has no equivalent in the design's auth_user;
    // avatars live in `imageFileId`/`file` instead, this column stays unused.
    image: text('image'),
    firstName: text('first_name').notNull(),
    lastName: text('last_name').notNull(),
    imageFileId: uuid('image_file_id').references((): AnyPgColumn => file.id),
    bio: text('bio'),
    studentId: text('student_id'),
    telephone: text('telephone'),
    majorId: uuid('major_id').references(() => major.id),
    academicYear: integer('academic_year'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    unique('auth_user_email_key').on(table.email),
    check(
      'auth_user_academic_year_check',
      sql`${table.academicYear} IS NULL OR (${table.academicYear} >= 1000 AND ${table.academicYear} <= 9999)`,
    ),
    index('auth_user_major_id_idx').on(table.majorId),
    uniqueIndex('auth_user_student_id_uidx')
      .on(table.studentId)
      .where(sql`${table.studentId} IS NOT NULL`),
  ],
);

export const authAdmin = pgTable(
  'auth_admin',
  {
    id: text('id').primaryKey(),
    username: text('username'),
    email: text('email').notNull(),
    firstName: text('first_name').notNull(),
    lastName: text('last_name').notNull(),
    imageFileId: uuid('image_file_id').references(() => file.id),
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex('auth_admin_email_uidx').on(sql`lower(${table.email})`),
    uniqueIndex('auth_admin_username_uidx')
      .on(sql`lower(${table.username})`)
      .where(sql`${table.username} IS NOT NULL`),
  ],
);

export const authSession = pgTable(
  'auth_session',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').references(() => authUser.id, { onDelete: 'cascade' }),
    adminId: text('admin_id').references(() => authAdmin.id, { onDelete: 'cascade' }),
    token: text('token').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    unique('auth_session_token_key').on(table.token),
    check('auth_session_check', sql`num_nonnulls(${table.userId}, ${table.adminId}) = 1`),
    index('auth_session_admin_id_idx').on(table.adminId),
    index('auth_session_user_id_idx').on(table.userId),
  ],
);

export const authAccount = pgTable(
  'auth_account',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').references(() => authUser.id, { onDelete: 'cascade' }),
    adminId: text('admin_id').references(() => authAdmin.id, { onDelete: 'cascade' }),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
    scope: text('scope'),
    password: text('password'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    check('auth_account_check', sql`num_nonnulls(${table.userId}, ${table.adminId}) = 1`),
    check(
      'auth_account_check1',
      sql`${table.adminId} IS NULL OR ${table.providerId} = 'credential'`,
    ),
    unique('auth_account_provider_id_account_id_key').on(table.providerId, table.accountId),
    index('auth_account_admin_id_idx').on(table.adminId),
    index('auth_account_user_id_idx').on(table.userId),
  ],
);

export const authVerification = pgTable(
  'auth_verification',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index('auth_verification_identifier_idx').on(table.identifier)],
);

export const authUserRelations = relations(authUser, ({ many, one }) => ({
  sessions: many(authSession),
  accounts: many(authAccount),
  major: one(major, {
    fields: [authUser.majorId],
    references: [major.id],
  }),
  image: one(file, {
    fields: [authUser.imageFileId],
    references: [file.id],
  }),
}));

export const authAdminRelations = relations(authAdmin, ({ many, one }) => ({
  sessions: many(authSession),
  accounts: many(authAccount),
  image: one(file, {
    fields: [authAdmin.imageFileId],
    references: [file.id],
  }),
}));

export const authSessionRelations = relations(authSession, ({ one }) => ({
  user: one(authUser, {
    fields: [authSession.userId],
    references: [authUser.id],
  }),
  admin: one(authAdmin, {
    fields: [authSession.adminId],
    references: [authAdmin.id],
  }),
}));

export const authAccountRelations = relations(authAccount, ({ one }) => ({
  user: one(authUser, {
    fields: [authAccount.userId],
    references: [authUser.id],
  }),
  admin: one(authAdmin, {
    fields: [authAccount.adminId],
    references: [authAdmin.id],
  }),
}));
