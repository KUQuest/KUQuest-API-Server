import { tag } from '@/database/schema/tag.schema';

import { describe, expect, it } from 'bun:test';
import { getTableColumns } from 'drizzle-orm';

describe('Tag database schema', () => {
  it('stores generated UUID ids and bounded unique names', () => {
    const columns = getTableColumns(tag);

    expect(columns.id.columnType).toBe('PgUUID');
    expect(columns.name.columnType).toBe('PgVarchar');
    expect(columns.name.getSQLType()).toBe('varchar(100)');
    expect(columns.name.notNull).toBe(true);
  });
});
