export const penaltyMemberNotificationTypes = [
  'PENALTY_RED_FLAG_APPLIED',
  'PENALTY_RED_FLAG_EXPIRED',
  'PENALTY_BAN_APPLIED',
  'PENALTY_BAN_ENDED',
  'CONDUCT_REPORT_UPHELD',
] as const;
export type PenaltyMemberNotificationType = (typeof penaltyMemberNotificationTypes)[number];

export const questMemberNotificationTypes = [
  'UNDERFILLED_DECISION_PENDING',
  'UNDERFILLED_CONSENT_PENDING',
  'UNDERFILLED_COMPLETED',
  'UNDERFILLED_CANCELLED',
  'QUEST_ASSIGNED',
  'PROOF_NOT_APPROVED',
  'QUEST_COMPLETED_DISPUTE_WINDOW_OPEN',
  'QUEST_FAILED',
] as const;

export const disputeMemberNotificationTypes = [
  'DISPUTE_CASE_FILED_AGAINST_YOU',
  'DISPUTE_CASE_DECIDED',
] as const;

export const memberNotificationTypes = [
  ...penaltyMemberNotificationTypes,
  ...questMemberNotificationTypes,
  ...disputeMemberNotificationTypes,
] as const;
export type MemberNotificationType = (typeof memberNotificationTypes)[number];

export const memberNotificationResults = ['RED_FLAG', 'TEMPORARY_BAN', 'PERMANENT_BAN'] as const;
export type MemberNotificationResult = (typeof memberNotificationResults)[number];

export const memberNotificationLadders = ['MISCONDUCT', 'REVIEW'] as const;
export type MemberNotificationLadder = (typeof memberNotificationLadders)[number];

export const memberNotificationSources = [
  'REPORT_CASE',
  'CONDUCT_REPORT',
  'REVIEW_AVERAGE',
] as const;
export type MemberNotificationSource = (typeof memberNotificationSources)[number];

/**
 * Every penalty Member Notification type is a critical Event. A Member cannot mute it per Quest.
 * The Push worker has no Quest mute filter today. A future filter must skip these types.
 */
export const criticalMemberNotificationTypes: readonly MemberNotificationType[] =
  penaltyMemberNotificationTypes;

export const memberNotificationCategories = ['PENALTY', 'QUEST', 'DISPUTE'] as const;
export type MemberNotificationCategory = (typeof memberNotificationCategories)[number];

/** Pure. Groups a Member Notification type for the inbox filter and the Push `category`. */
export const categoryOfNotificationType = (
  type: MemberNotificationType
): MemberNotificationCategory => {
  if ((penaltyMemberNotificationTypes as readonly string[]).includes(type)) return 'PENALTY';
  if ((disputeMemberNotificationTypes as readonly string[]).includes(type)) return 'DISPUTE';
  return 'QUEST';
};

export const memberNotificationActorRoles = ['HIRER', 'WORKER'] as const;
export type MemberNotificationActorRole = (typeof memberNotificationActorRoles)[number];

export const memberNotificationCancellationReasons = [
  'HIRER_CANCELLED',
  'HIRER_NO_DECISION',
  'WORKER_DECLINED',
  'CONSENT_TIMEOUT',
] as const;
export type MemberNotificationCancellationReason =
  (typeof memberNotificationCancellationReasons)[number];

export const memberNotificationFailureReasons = [
  'PROOF_NOT_APPROVED',
  'COMPLETION_NOT_APPROVED',
  'DUE_AT_MISSED',
] as const;
export type MemberNotificationFailureReason = (typeof memberNotificationFailureReasons)[number];

export const memberNotificationDisputeStatuses = [
  'DISPUTE_CASE_DISMISSED',
  'DISPUTE_CASE_RESOLVED',
] as const;
export type MemberNotificationDisputeStatus = (typeof memberNotificationDisputeStatuses)[number];
