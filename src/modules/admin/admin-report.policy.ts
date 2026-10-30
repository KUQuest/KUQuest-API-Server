import type { AdminActionReasonCatalog } from './admin-action.policy';

export const reportCaseDismissReasonCodes = [
  'REPORT_NO_POLICY_VIOLATION',
  'REPORT_INSUFFICIENT_EVIDENCE',
  'REPORT_CONTEXT_SUPPORTS_MESSAGE',
] as const;

export type ReportCaseDismissReasonCode = (typeof reportCaseDismissReasonCodes)[number];

export const reportCaseHideReasonCodes = [
  'REPORT_HARASSMENT_CONFIRMED',
  'REPORT_SPAM_CONFIRMED',
  'REPORT_THREAT_CONFIRMED',
  'REPORT_INAPPROPRIATE_CONTENT_CONFIRMED',
  'REPORT_OTHER_POLICY_VIOLATION_CONFIRMED',
] as const;

export type ReportCaseHideReasonCode = (typeof reportCaseHideReasonCodes)[number];

export const reportCaseRestoreReasonCodes = [
  'REPORT_MESSAGE_COMPLIES_WITH_POLICY',
  'REPORT_CONTEXT_WAS_MISUNDERSTOOD',
  'REPORT_NEW_EVIDENCE_OVERTURNS_HIDE',
] as const;

export type ReportCaseRestoreReasonCode = (typeof reportCaseRestoreReasonCodes)[number];

export const conductReportDismissReasonCodes = [
  'CONDUCT_REPORT_NO_VIOLATION',
  'CONDUCT_REPORT_INSUFFICIENT_EVIDENCE',
  'CONDUCT_REPORT_QUEST_RECORD_DISPROVES_CLAIM',
  'CONDUCT_REPORT_OUTSIDE_RULEBOOK_SCOPE',
] as const;

export type ConductReportDismissReasonCode = (typeof conductReportDismissReasonCodes)[number];

export const conductReportUpholdReasonCodes = [
  'CONDUCT_REPORT_QUEST_RECORD_CONFIRMS_VIOLATION',
  'CONDUCT_REPORT_PROOF_RECORD_CONFIRMS_VIOLATION',
  'CONDUCT_REPORT_CHAT_CONTEXT_CORROBORATES_VIOLATION',
] as const;

export type ConductReportUpholdReasonCode = (typeof conductReportUpholdReasonCodes)[number];

export const reportAdminActionCatalog: AdminActionReasonCatalog = {
  version: 2,
  actions: {
    REPORT_CASE_DISMISS: {
      kind: 'COMMAND',
      requiresReason: true,
      allowedReasonCodes: reportCaseDismissReasonCodes,
    },
    REPORT_CASE_HIDE: {
      kind: 'COMMAND',
      requiresReason: true,
      allowedReasonCodes: reportCaseHideReasonCodes,
    },
    REPORT_CASE_RESTORE: {
      kind: 'COMMAND',
      requiresReason: true,
      allowedReasonCodes: reportCaseRestoreReasonCodes,
    },
    CONDUCT_REPORT_DISMISS: {
      kind: 'COMMAND',
      requiresReason: true,
      allowedReasonCodes: conductReportDismissReasonCodes,
    },
    CONDUCT_REPORT_UPHOLD: {
      kind: 'COMMAND',
      requiresReason: true,
      allowedReasonCodes: conductReportUpholdReasonCodes,
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
