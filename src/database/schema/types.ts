import { customType } from 'drizzle-orm/pg-core';

// PostgreSQL's case-insensitive text type; migration 0012 creates the extension.
export const citext = customType<{ data: string; driverData: string }>({
  dataType: () => 'citext',
});
