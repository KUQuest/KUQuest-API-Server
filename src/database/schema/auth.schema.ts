import { relations, sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import {
  boolean,
  check,
  index,
  inet,
  integer,
  pgTable,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import { department, occupation } from './academic.schema';
import { citext } from './types';
import { file } from './file.schema';

export const authUser = pgTable(
  'auth_user',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    email: citext('email').notNull(),
    emailVerified: boolean('email_verified').default(false).notNull(),
    image: varchar('image', { length: 2048 }),
    firstName: varchar('first_name', { length: 100 }).notNull(),
    lastName: varchar('last_name', { length: 100 }).notNull(),
    imageFileId: uuid('image_file_id').references((): AnyPgColumn => file.id),
    bio: varchar('bio', { length: 1000 }),
    studentId: varchar('student_id', { length: 10 }),
    telephone: varchar('telephone', { length: 12 }),
    departmentId: uuid('department_id').references(() => department.id),
    academicYear: integer('academic_year'),
    occupationId: uuid('occupation_id').references(() => occupation.id),
    termsAcceptedAt: timestamp('terms_accepted_at', { withTimezone: true }),
    termsVersion: varchar('terms_version', { length: 50 }),
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
      sql`${table.academicYear} IS NULL OR ${table.academicYear} BETWEEN 1000 AND 9999`,
    ),
    index('auth_user_department_id_idx').on(table.departmentId),
    uniqueIndex('auth_user_student_id_uidx')
      .on(table.studentId)
      .where(sql`${table.studentId} IS NOT NULL`),
  ],
);

export const authAdmin = pgTable(
  'auth_admin',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    username: varchar('username', { length: 100 }),
    email: citext('email').notNull(),
    emailVerified: boolean('email_verified').default(false).notNull(),
    image: varchar('image', { length: 2048 }),
    firstName: varchar('first_name', { length: 100 }).notNull(),
    lastName: varchar('last_name', { length: 100 }).notNull(),
    imageFileId: uuid('image_file_id').references((): AnyPgColumn => file.id),
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex('auth_admin_email_uidx').on(table.email),
    uniqueIndex('auth_admin_username_uidx')
      .on(sql`lower(${table.username})`)
      .where(sql`${table.username} IS NOT NULL`),
  ],
);

export const authSession = pgTable(
  'auth_session',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id').references(() => authUser.id, { onDelete: 'cascade' }),
    adminId: uuid('admin_id').references(() => authAdmin.id, { onDelete: 'cascade' }),
    token: varchar('token', { length: 255 }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    ipAddress: inet('ip_address'),
    userAgent: varchar('user_agent', { length: 512 }),
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
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id').references(() => authUser.id, { onDelete: 'cascade' }),
    adminId: uuid('admin_id').references(() => authAdmin.id, { onDelete: 'cascade' }),
    accountId: varchar('account_id', { length: 255 }).notNull(),
    providerId: varchar('provider_id', { length: 100 }).notNull(),
    accessToken: varchar('access_token', { length: 8192 }),
    refreshToken: varchar('refresh_token', { length: 8192 }),
    idToken: varchar('id_token', { length: 8192 }),
    accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
    scope: varchar('scope', { length: 2048 }),
    password: varchar('password', { length: 255 }),
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
    id: uuid('id').defaultRandom().primaryKey(),
    identifier: citext('identifier').notNull(),
    value: varchar('value', { length: 2048 }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index('auth_verification_identifier_idx').on(table.identifier)],
);

export const authUserRelations = relations(authUser, ({ many, one }) => ({
  sessions: many(authSession),
  accounts: many(authAccount),
  department: one(department, {
    fields: [authUser.departmentId],
    references: [department.id],
  }),
  occupation: one(occupation, {
    fields: [authUser.occupationId],
    references: [occupation.id],
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
