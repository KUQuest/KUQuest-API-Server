const formatDisplayId = (prefix: string, publicSequence: number): string =>
  `${prefix}-${publicSequence.toString().padStart(6, '0')}`;

export const formatReportCaseDisplayId = (publicSequence: number): string =>
  formatDisplayId('RPT', publicSequence);

export const formatConductReportDisplayId = (publicSequence: number): string =>
  formatDisplayId('CND', publicSequence);

export const formatPayoutDisplayId = (publicSequence: number): string =>
  formatDisplayId('PAY', publicSequence);

export const formatTopUpDisplayId = (publicSequence: number): string =>
  formatDisplayId('TOP', publicSequence);

export const formatWalletDisplayId = (publicSequence: number): string =>
  formatDisplayId('WLT', publicSequence);

export const formatLedgerTransactionDisplayReference = (publicSequence: number): string =>
  formatDisplayId('LTX', publicSequence);
