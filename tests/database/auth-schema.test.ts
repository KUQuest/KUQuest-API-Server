import { describe, expect, it } from 'bun:test';
import { getTableColumns } from 'drizzle-orm';

import { authUser } from '@/database/schema/auth.schema';

describe('authentication database schema', () => {
  it('uses the requested user database columns', () => {
    const columns = getTableColumns(authUser);

    expect(columns.id.name).toBe('id');
    expect(columns.id.primary).toBe(true);
    expect(columns.firstName.name).toBe('first_name');
    expect(columns.lastName.name).toBe('last_name');
  });
});
