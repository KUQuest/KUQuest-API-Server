import type { AdminActionReasonCatalog } from '@/modules/admin';

export const disputeCaseDismissReasonCodes = [
  'DISPUTE_INSUFFICIENT_EVIDENCE',
  'DISPUTE_QUEST_RECORD_DOES_NOT_SUPPORT_CLAIM',
  'DISPUTE_NO_UNFAIR_SETTLEMENT_FOUND',
  'DISPUTE_WORKER_ALREADY_COMPENSATED',
] as const;

export type DisputeCaseDismissReasonCode = (typeof disputeCaseDismissReasonCodes)[number];

export const disputeCaseResolveReasonCodes = [
  'DISPUTE_VALID_PROOF_NOT_APPROVED',
  'DISPUTE_WORKER_MET_QUEST_CONDITION',
  'DISPUTE_PARTIAL_WORK_EARNED_REWARD',
] as const;

export type DisputeCaseResolveReasonCode = (typeof disputeCaseResolveReasonCodes)[number];

export const disputeAdminActionCatalog: AdminActionReasonCatalog = {
  version: 2,
  actions: {
    DISPUTE_CASE_DISMISS: {
      kind: 'COMMAND',
      requiresReason: true,
      allowedReasonCodes: disputeCaseDismissReasonCodes,
    },
    DISPUTE_CASE_RESOLVE: {
      kind: 'COMMAND',
      requiresReason: true,
      allowedReasonCodes: disputeCaseResolveReasonCodes,
    },
    DISPUTE_CASE_EVIDENCE_ACCESS: {
      kind: 'EVIDENCE_ACCESS',
      requiresReason: false,
      allowedReasonCodes: [],
    },
  },
};
