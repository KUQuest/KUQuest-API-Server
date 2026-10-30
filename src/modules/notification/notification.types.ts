export const memberNotificationTypes = [
  'PENALTY_RED_FLAG_APPLIED',
  'PENALTY_RED_FLAG_EXPIRED',
  'PENALTY_BAN_APPLIED',
  'PENALTY_BAN_ENDED',
  'CONDUCT_REPORT_UPHELD',
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
 * Every Member Notification type is a critical Event. A Member cannot mute it per Quest.
 * The Push worker has no Quest mute filter today. A future filter must skip these types.
 */
export const criticalMemberNotificationTypes: readonly MemberNotificationType[] =
  memberNotificationTypes;
