import {
  formatConductReportDisplayId,
  formatDisputeDisplayId,
  formatQuestDisplayId,
  formatReportCaseDisplayId,
} from '@/modules/admin/admin-display-id';

import { describe, expect, it } from 'bun:test';

describe('Quest display ID', () => {
  it('formats the first Quest as QST-000001', () => {
    expect(formatQuestDisplayId(1)).toBe('QST-000001');
  });

  it('keeps the six-digit minimum while allowing larger sequences', () => {
    expect(formatQuestDisplayId(42)).toBe('QST-000042');
    expect(formatQuestDisplayId(1_000_000)).toBe('QST-1000000');
  });
});

describe('Dispute Case display ID', () => {
  it('formats the first Dispute Case as DSP-000001', () => {
    expect(formatDisputeDisplayId(1)).toBe('DSP-000001');
  });

  it('keeps the six-digit minimum while allowing larger sequences', () => {
    expect(formatDisputeDisplayId(42)).toBe('DSP-000042');
    expect(formatDisputeDisplayId(1_000_000)).toBe('DSP-1000000');
  });
});

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
