import { sql, type SQLWrapper } from 'drizzle-orm';

const displayIdWidth = 6;
const displayIdPrefixes = {
  activity: 'ACT',
  member: 'MEM',
  quest: 'QST',
  dispute: 'DSP',
  reportCase: 'RPT',
  conductReport: 'CND',
  payout: 'PAY',
  topUp: 'TOP',
  wallet: 'WLT',
  ledgerTransaction: 'LTX',
} as const;

type DisplayIdType = keyof typeof displayIdPrefixes;

const formatDisplayId = (type: DisplayIdType, publicSequence: number): string =>
  `${displayIdPrefixes[type]}-${publicSequence.toString().padStart(displayIdWidth, '0')}`;

export const formatDisplayIdSql = (type: DisplayIdType, publicSequence: SQLWrapper) => {
  const sequenceText = sql<string>`cast(${publicSequence} as text)`;
  const paddedSequence = sql<string>`lpad(${sequenceText}, greatest(${displayIdWidth}, length(${sequenceText})), '0')`;

  return sql<string>`concat(cast(${displayIdPrefixes[type]} as text), '-', ${paddedSequence})`;
};

export const formatQuestDisplayId = (publicSequence: number): string =>
  formatDisplayId('quest', publicSequence);

export const formatActivityDisplayId = (publicSequence: number): string =>
  formatDisplayId('activity', publicSequence);

export const formatDisputeDisplayId = (publicSequence: number): string =>
  formatDisplayId('dispute', publicSequence);

export const formatReportCaseDisplayId = (publicSequence: number): string =>
  formatDisplayId('reportCase', publicSequence);

export const formatConductReportDisplayId = (publicSequence: number): string =>
  formatDisplayId('conductReport', publicSequence);

export const formatPayoutDisplayId = (publicSequence: number): string =>
  formatDisplayId('payout', publicSequence);

export const formatTopUpDisplayId = (publicSequence: number): string =>
  formatDisplayId('topUp', publicSequence);

export const formatWalletDisplayId = (publicSequence: number): string =>
  formatDisplayId('wallet', publicSequence);

export const formatLedgerTransactionDisplayReference = (publicSequence: number): string =>
  formatDisplayId('ledgerTransaction', publicSequence);
