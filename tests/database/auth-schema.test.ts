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

  it('stores Academic Registration fields renamed/added for BE-94', () => {
    const columns = getTableColumns(authUser);

    expect(columns.departmentId.name).toBe('department_id');
    expect(columns.occupationId.name).toBe('occupation_id');
    expect(columns.termsAcceptedAt.name).toBe('terms_accepted_at');
    expect(columns.termsVersion.name).toBe('terms_version');
    expect(columns).not.toHaveProperty('majorId');
  });
});
