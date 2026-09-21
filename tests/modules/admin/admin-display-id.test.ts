import { formatReportCaseDisplayId } from '@/modules/admin/admin-display-id';

import { describe, expect, it } from 'bun:test';

describe('Report Case display ID', () => {
  it('formats the first Report Case as RPT-000001', () => {
    expect(formatReportCaseDisplayId(1)).toBe('RPT-000001');
  });

  it('keeps the six-digit minimum while allowing larger sequences', () => {
    expect(formatReportCaseDisplayId(42)).toBe('RPT-000042');
    expect(formatReportCaseDisplayId(1_000_000)).toBe('RPT-1000000');
  });
});
