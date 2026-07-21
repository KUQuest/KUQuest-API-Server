import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/database/schema/*.ts',
  out: './drizzle',
  dbCredentials: {
    url:
      process.env.DATABASE_URL ||
      'postgresql://kuquest:kuquest-local-only@localhost:5432/kuquest',
  },
  strict: true,
  verbose: true,
});
