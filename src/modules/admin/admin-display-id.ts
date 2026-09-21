export const formatReportCaseDisplayId = (publicSequence: number): string =>
  `RPT-${publicSequence.toString().padStart(6, '0')}`;
