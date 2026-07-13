import { describe, expect, it } from 'bun:test';
import { getTableColumns } from 'drizzle-orm';

import { user } from '@/database/schema/auth.schema';

describe('authentication database schema', () => {
  it('uses the requested user database columns', () => {
    const columns = getTableColumns(user);

    expect(columns.id.name).toBe('user_id');
    expect(columns.id.primary).toBe(true);
    expect(columns.firstName.name).toBe('first_name');
    expect(columns.lastName.name).toBe('last_name');
  });
});
