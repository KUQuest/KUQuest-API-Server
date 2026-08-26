import { quest } from '@/database/schema/quest.schema';

import { describe, expect, it } from 'bun:test';
import { getTableColumns } from 'drizzle-orm';

describe('Quest database schema', () => {
  it('stores the Quest Reward as integer Satang', () => {
    const columns = getTableColumns(quest);

    expect(columns).toHaveProperty('rewardSatang');
    expect(columns).not.toHaveProperty('rewardBaht');
    expect(columns.rewardSatang.name).toBe('reward_satang');
    expect(columns.rewardSatang.dataType).toBe('number');
  });
});
