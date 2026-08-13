import { relations, sql } from 'drizzle-orm';
import {
  check,
  date,
  index,
  integer,
  pgTable,
  timestamp,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import { authUser } from './auth.schema';
import { file } from './file.schema';

export const tag = pgTable(
  'tag',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    name: varchar('name', { length: 100 }).notNull(),
  },
  (table) => [unique('tag_name_key').on(table.name)],
);

export const profileCertificate = pgTable(
  'profile_certificate',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => authUser.id),
    name: varchar('name', { length: 200 }).notNull(),
    issuer: varchar('issuer', { length: 200 }).notNull(),
    issuedAt: date('issued_at').notNull(),
    imageFileId: uuid('image_file_id').references(() => file.id),
    version: integer('version').default(1).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index('profile_certificate_user_idx').on(table.userId)],
);

export const profilePortfolioItem = pgTable(
  'profile_portfolio_item',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => authUser.id),
    title: varchar('title', { length: 120 }).notNull(),
    description: varchar('description', { length: 1000 }),
    version: integer('version').default(1).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index('profile_portfolio_item_user_idx').on(table.userId)],
);

export const profilePortfolioItemImage = pgTable(
  'profile_portfolio_item_image',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    portfolioItemId: uuid('portfolio_item_id')
      .notNull()
      .references(() => profilePortfolioItem.id, { onDelete: 'cascade' }),
    fileId: uuid('file_id')
      .notNull()
      .references(() => file.id),
    position: integer('position').default(0).notNull(),
  },
  (table) => [
    unique('profile_portfolio_item_image_portfolio_item_id_position_key').on(
      table.portfolioItemId,
      table.position,
    ),
    index('profile_portfolio_item_image_item_idx').on(table.portfolioItemId),
  ],
);

export const profileWorkExperience = pgTable(
  'profile_work_experience',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => authUser.id),
    title: varchar('title', { length: 120 }).notNull(),
    employmentType: varchar('employment_type', { length: 50 }).notNull(),
    org: varchar('org', { length: 200 }),
    description: varchar('description', { length: 1000 }),
    startedAt: date('started_at').notNull(),
    endedAt: date('ended_at'),
    version: integer('version').default(1).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check(
      'profile_work_experience_check',
      sql`${table.endedAt} IS NULL OR ${table.endedAt} >= ${table.startedAt}`,
    ),
    index('profile_work_experience_user_idx').on(table.userId),
  ],
);

export const profileCertificateRelations = relations(profileCertificate, ({ one }) => ({
  user: one(authUser, {
    fields: [profileCertificate.userId],
    references: [authUser.id],
  }),
  image: one(file, {
    fields: [profileCertificate.imageFileId],
    references: [file.id],
  }),
}));

export const profilePortfolioItemRelations = relations(profilePortfolioItem, ({ one, many }) => ({
  user: one(authUser, {
    fields: [profilePortfolioItem.userId],
    references: [authUser.id],
  }),
  images: many(profilePortfolioItemImage),
}));

export const profilePortfolioItemImageRelations = relations(profilePortfolioItemImage, ({ one }) => ({
  portfolioItem: one(profilePortfolioItem, {
    fields: [profilePortfolioItemImage.portfolioItemId],
    references: [profilePortfolioItem.id],
  }),
  file: one(file, {
    fields: [profilePortfolioItemImage.fileId],
    references: [file.id],
  }),
}));

export const profileWorkExperienceRelations = relations(profileWorkExperience, ({ one }) => ({
  user: one(authUser, {
    fields: [profileWorkExperience.userId],
    references: [authUser.id],
  }),
}));
