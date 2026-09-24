export const formatReportCaseDisplayId = (publicSequence: number): string =>
  `RPT-${publicSequence.toString().padStart(6, '0')}`;

export const formatConductReportDisplayId = (publicSequence: number): string =>
  `CND-${publicSequence.toString().padStart(6, '0')}`;
