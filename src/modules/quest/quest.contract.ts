/**
 * BE-170 canonical Quest domain contract.
 *
 * Single source of truth for the Quest domain's shared status/type
 * vocabularies, mirroring the EDR at docs/db/edr/05-quest.sql. Every status
 * value is entity-prefixed (QUEST_*, TEAM_*, APPLICATION_*, ASSIGNMENT_*,
 * PROOF_*, EDIT_REQUEST_*, EDIT_RESPONSE_*, INVITATION_*) so vocabularies
 * cannot collide across tables or API payloads.
 *
 * Member identity is native UUID (auth_user.id); Admin identity is native
 * UUID (auth_admin.id). Quest actor columns are hirer_id/worker_id.
 *
 * Wallet statuses are owned by the Wallet domain and deliberately absent.
 */

export const questMode = {
  noCandidate: 'NO_CANDIDATE',
  candidate: 'CANDIDATE',
} as const;
export const questModes = [questMode.noCandidate, questMode.candidate] as const;
export type QuestMode = (typeof questModes)[number];

export const questParticipation = {
  solo: 'SOLO',
  group: 'GROUP',
} as const;
export const questParticipations = [
  questParticipation.solo,
  questParticipation.group,
] as const;
export type QuestParticipation = (typeof questParticipations)[number];

export const questStatus = {
  draft: 'QUEST_DRAFT',
  open: 'QUEST_OPEN',
  awaitingConsent: 'QUEST_AWAITING_CONSENT',
  assigned: 'QUEST_ASSIGNED',
  inProgress: 'QUEST_IN_PROGRESS',
  submitted: 'QUEST_SUBMITTED',
  approved: 'QUEST_APPROVED',
  rework: 'QUEST_REWORK',
  completed: 'QUEST_COMPLETED',
  cancelled: 'QUEST_CANCELLED',
  disputed: 'QUEST_DISPUTED',
  hidden: 'QUEST_HIDDEN',
} as const;
export const questStatuses = [
  questStatus.draft,
  questStatus.open,
  questStatus.awaitingConsent,
  questStatus.assigned,
  questStatus.inProgress,
  questStatus.submitted,
  questStatus.approved,
  questStatus.rework,
  questStatus.completed,
  questStatus.cancelled,
  questStatus.disputed,
  questStatus.hidden,
] as const;
export type QuestStatus = (typeof questStatuses)[number];

export const teamStatus = {
  forming: 'TEAM_FORMING',
  submitted: 'TEAM_SUBMITTED',
  selected: 'TEAM_SELECTED',
  rejected: 'TEAM_REJECTED',
  disbanded: 'TEAM_DISBANDED',
} as const;
export const teamStatuses = [
  teamStatus.forming,
  teamStatus.submitted,
  teamStatus.selected,
  teamStatus.rejected,
  teamStatus.disbanded,
] as const;
export type TeamStatus = (typeof teamStatuses)[number];

export const applicationStatus = {
  applied: 'APPLICATION_APPLIED',
  selected: 'APPLICATION_SELECTED',
  rejected: 'APPLICATION_REJECTED',
  withdrawn: 'APPLICATION_WITHDRAWN',
} as const;
export const applicationStatuses = [
  applicationStatus.applied,
  applicationStatus.selected,
  applicationStatus.rejected,
  applicationStatus.withdrawn,
] as const;
export type ApplicationStatus = (typeof applicationStatuses)[number];

export const assignmentStatus = {
  active: 'ASSIGNMENT_ACTIVE',
  completed: 'ASSIGNMENT_COMPLETED',
  incomplete: 'ASSIGNMENT_INCOMPLETE',
  cancelled: 'ASSIGNMENT_CANCELLED',
} as const;
export const assignmentStatuses = [
  assignmentStatus.active,
  assignmentStatus.completed,
  assignmentStatus.incomplete,
  assignmentStatus.cancelled,
] as const;
export type AssignmentStatus = (typeof assignmentStatuses)[number];

export const proofStatuses = [
  'PROOF_PENDING',
  'PROOF_APPROVED',
  'PROOF_REJECTED',
  'PROOF_AUTO_APPROVED',
] as const;
export type ProofStatus = (typeof proofStatuses)[number];

export const editRequestStatuses = [
  'EDIT_REQUEST_PENDING',
  'EDIT_REQUEST_APPROVED',
  'EDIT_REQUEST_REJECTED',
] as const;
export type EditRequestStatus = (typeof editRequestStatuses)[number];

export const editResponseDecisions = [
  'EDIT_RESPONSE_APPROVED',
  'EDIT_RESPONSE_REJECTED',
] as const;
export type EditResponseDecision = (typeof editResponseDecisions)[number];

export const invitationStatuses = [
  'INVITATION_PENDING',
  'INVITATION_ACCEPTED',
  'INVITATION_DECLINED',
  'INVITATION_EXPIRED',
  'INVITATION_REVOKED',
] as const;
export type InvitationStatus = (typeof invitationStatuses)[number];

/** A Quest status from which the Work Conversation is read-only. */
export type TerminalQuestStatus = Extract<
  QuestStatus,
  (typeof questStatus)['completed' | 'cancelled']
>;

/** An Assignment status of a departed Worker — no current Work Conversation membership. */
export type InactiveAssignmentStatus = Extract<
  AssignmentStatus,
  (typeof assignmentStatus)['incomplete' | 'cancelled']
>;
