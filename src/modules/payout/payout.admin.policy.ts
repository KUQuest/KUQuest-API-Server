import type { AdminActionReasonCatalog } from '@/modules/admin';

export const payoutApprovalReasonCodes = [
  'PAYOUT_DESTINATION_VERIFIED',
  'PAYOUT_ACCOUNT_OWNER_MATCHED',
  'PAYOUT_POLICY_CHECK_PASSED',
  'PAYOUT_RISK_REVIEW_CLEARED',
] as const;

export const payoutCancellationReasonCodes = [
  'PAYOUT_INVALID_DESTINATION',
  'PAYOUT_ACCOUNT_OWNER_MISMATCH',
  'PAYOUT_POLICY_CHECK_FAILED',
  'PAYOUT_RISK_REVIEW_FAILED',
  'PAYOUT_REQUIRED_INFORMATION_MISSING',
] as const;

export const payoutAdminReasonCodes = [
  ...payoutApprovalReasonCodes,
  ...payoutCancellationReasonCodes,
] as const;

export const payoutApprovalReasonCodesV1 = ['PAYOUT_POLICY_REVIEW', 'PAYOUT_RISK_REVIEW'] as const;

export const payoutCancellationReasonCodesV1 = [
  ...payoutApprovalReasonCodesV1,
  'PAYOUT_INVALID_DESTINATION',
] as const;

export const payoutAdminActionCatalog: AdminActionReasonCatalog = {
  version: 2,
  actions: {
    PAYOUT_APPROVE: {
      kind: 'COMMAND',
      requiresReason: true,
      allowedReasonCodes: payoutApprovalReasonCodes,
    },
    PAYOUT_CANCEL: {
      kind: 'COMMAND',
      requiresReason: true,
      allowedReasonCodes: payoutCancellationReasonCodes,
    },
  },
};
