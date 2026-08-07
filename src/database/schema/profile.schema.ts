import { relations, sql } from 'drizzle-orm';
import {
  check,
  date,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { authUser } from './auth.schema';
import { file } from './file.schema';

export const profileCertificate = pgTable(
  'profile_certificate',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => authUser.id),
    name: text('name').notNull(),
    issuer: text('issuer').notNull(),
    issuedAt: date('issued_at').notNull(),
    verifyUrl: text('verify_url'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index('profile_certificate_user_idx').on(table.userId)],
);

export const profilePortfolioItem = pgTable(
  'profile_portfolio_item',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => authUser.id),
    title: text('title').notNull(),
    description: text('description'),
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
    userId: text('user_id')
      .notNull()
      .references(() => authUser.id),
    title: text('title').notNull(),
    employmentType: text('employment_type').notNull(),
    org: text('org'),
    description: text('description'),
    startedAt: date('started_at').notNull(),
    endedAt: date('ended_at'),
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
