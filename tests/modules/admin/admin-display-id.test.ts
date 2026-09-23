import {
  formatConductReportDisplayId,
  formatReportCaseDisplayId,
} from '@/modules/admin/admin-display-id';

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

describe('Conduct Report display ID', () => {
  it('formats the first Conduct Report as CND-000001', () => {
    expect(formatConductReportDisplayId(1)).toBe('CND-000001');
  });

  it('keeps the six-digit minimum while allowing larger sequences', () => {
    expect(formatConductReportDisplayId(42)).toBe('CND-000042');
    expect(formatConductReportDisplayId(1_000_000)).toBe('CND-1000000');
  });
});
