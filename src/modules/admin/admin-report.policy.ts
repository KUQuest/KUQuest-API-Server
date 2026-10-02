import { conductReportReasons } from '@/database/schema/admin.schema';

import type { AdminActionReasonCatalog } from './admin-action.policy';

export const reportAdminReasonCodes = ['POLICY_REVIEW', 'SAFETY_REVIEW'] as const;

export const conductReportDismissReasonCodes = [
  'CONDUCT_REPORT_NO_VIOLATION',
  'CONDUCT_REPORT_INSUFFICIENT_EVIDENCE',
] as const;

export type ConductReportDismissReasonCode = (typeof conductReportDismissReasonCodes)[number];

export const reportAdminActionCatalog: AdminActionReasonCatalog = {
  version: 1,
  actions: {
    REPORT_CASE_DISMISS: {
      kind: 'COMMAND',
      requiresReason: true,
      allowedReasonCodes: reportAdminReasonCodes,
    },
    REPORT_CASE_HIDE: {
      kind: 'COMMAND',
      requiresReason: true,
      allowedReasonCodes: reportAdminReasonCodes,
    },
    REPORT_CASE_RESTORE: {
      kind: 'COMMAND',
      requiresReason: true,
      allowedReasonCodes: reportAdminReasonCodes,
    },
    CONDUCT_REPORT_DISMISS: {
      kind: 'COMMAND',
      requiresReason: true,
      allowedReasonCodes: conductReportDismissReasonCodes,
    },
    CONDUCT_REPORT_UPHOLD: {
      kind: 'COMMAND',
      requiresReason: true,
      allowedReasonCodes: conductReportReasons,
    },
    REPORT_CASE_EVIDENCE_ACCESS: {
      kind: 'EVIDENCE_ACCESS',
      requiresReason: false,
      allowedReasonCodes: [],
    },
    CONDUCT_REPORT_EVIDENCE_ACCESS: {
      kind: 'EVIDENCE_ACCESS',
      requiresReason: false,
      allowedReasonCodes: [],
    },
    CONDUCT_REPORT_EVIDENCE_FILE_ACCESS: {
      kind: 'EVIDENCE_ACCESS',
      requiresReason: false,
      allowedReasonCodes: [],
    },
  },
};
