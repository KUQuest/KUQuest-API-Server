export const memberPenaltyAddReasonCodes = [
  'MEMBER_PENALTY_VIOLATION_CONFIRMED',
  'MEMBER_PENALTY_REPEATED_VIOLATION_CONFIRMED',
  'MEMBER_PENALTY_SAFETY_RISK_CONFIRMED',
  'MEMBER_PENALTY_OTHER_VIOLATION_CONFIRMED',
] as const;

export type MemberPenaltyAddReasonCode = (typeof memberPenaltyAddReasonCodes)[number];

export const memberPenaltyRemoveReasonCodes = [
  'MEMBER_PENALTY_ADMIN_ERROR',
  'MEMBER_PENALTY_NEW_EVIDENCE',
  'MEMBER_PENALTY_POLICY_REVIEW',
  'MEMBER_PENALTY_OTHER_CORRECTION',
] as const;

export type MemberPenaltyRemoveReasonCode = (typeof memberPenaltyRemoveReasonCodes)[number];

export const memberPenaltyCommandErrorCodes = [
  'ADMIN_DISABLED',
  'INVALID_IDEMPOTENCY_KEY',
  'INVALID_VERSION_TOKEN',
  'INVALID_ADMIN_NOTE',
  'MEMBER_NOT_FOUND',
  'PENALTY_RESULT_REQUIRED',
  'PENALTY_EXEMPTION_APPLIES',
  'PENALTY_RECORD_NOT_FOUND',
  'PENALTY_RECORD_NOT_EFFECTIVE',
  'IDEMPOTENCY_KEY_REUSED',
  'PENALTY_HISTORY_STALE',
] as const;

export type MemberPenaltyCommandErrorCode = (typeof memberPenaltyCommandErrorCodes)[number];

export class MemberPenaltyCommandError extends Error {
  constructor(
    readonly code: MemberPenaltyCommandErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'MemberPenaltyCommandError';
  }
}
