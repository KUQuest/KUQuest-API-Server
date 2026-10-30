import { db } from '@/database/client';
import {
  adminAction,
  adminDisputeCase,
  disputeCaseStatuses,
  type DisputeCaseCategory,
} from '@/database/schema/admin.schema';
import { authUser } from '@/database/schema/auth.schema';
import { file } from '@/database/schema/file.schema';
import {
  questCandidateTeamV2,
  proofSubmission,
  proofSubmissionImage,
  quest,
  questAssignment,
  questCandidateTeamV2Member,
  questV2ProofSubmission,
  questV2ProofSubmissionFile,
} from '@/database/schema/quest.schema';
import { walletWallet } from '@/database/schema/wallet.schema';
import { recordAudit } from '@/modules/audit/audit.service';
import {
  formatDisputeDisplayId,
  formatDisplayIdSql,
  formatQuestDisplayId,
  getAdminMemberModerationContext,
  notifyAdminResourceUpdated,
} from '@/modules/admin';
import type { AdminMemberModerationContextFields, AdminMemberStatus } from '@/modules/admin';
import {
  createAdminActionService,
  type AdminActionCommandInput,
  type AdminActionResult,
} from '@/modules/admin/admin-action.service';
import { insertMemberNotificationInTransaction } from '@/modules/notification';
import { positiveSatang, settleDisputeCase, type WalletTransaction } from '@/modules/wallet';
import { CursorInputError, type CursorPayload } from '@/shared/cursor';
import { readKeysetPage } from '@/shared/keyset-page';
import {
  buildStatusCounts,
  containsLikeQueryPattern,
  ilikeContains as adminListSearchValue,
  isoDateSearchText as adminListSearchDate,
} from '@/shared/list-search';

import { and, asc, count, desc, eq, or, sql } from 'drizzle-orm';

import { isMoneyHoldOpen, moneyHoldDurationMs } from '../shared';
import { readQuestEscrow } from '../shared/escrow/quest-escrow.service';
import { notifyQuestUpdate } from '../v2/realtime';
import {
  fullDisputeAmountSatang,
  openTeamDisputeSplit,
  readSelectedTeam,
  readTeamDisputeSplit,
  type TeamDisputeSplitView,
} from './quest-dispute-team-split.service';
import { questV2ProofStorage } from '../v2/proof/quest-proof-v2.storage';
import {
  disputeAdminActionCatalog,
  type DisputeCaseDismissReasonCode,
  type DisputeCaseResolveReasonCode,
} from './quest-dispute-admin.policy';

const dayMs = 24 * 60 * 60 * 1000;

/** Rulebook: a Hirer or Worker may self-file within 1 day of the Quest failing. */
export const disputeSelfFileWindowMs = dayMs;

/** Rulebook: each Dispute Case has seven days from `createdAt` for an Admin decision. */
export const disputeDecisionWindowMs = 7 * dayMs;

/** Tells the filer that their Dispute Case changed; clients refetch the Quest. */
const notifyDisputeCaseUpdated = (
  transaction: WalletTransaction,
  record: Pick<typeof adminDisputeCase.$inferSelect, 'questId' | 'filerUserId' | 'respondentUserId'>
) =>
  notifyQuestUpdate(transaction, {
    questId: record.questId,
    recipientMemberIds: [record.filerUserId, record.respondentUserId].filter(
      (userId): userId is string => userId !== null
    ),
    changeType: 'DISPUTE_CASE_UPDATED',
  });

/**
 * Admin Dispute Case queues, counts, detail, and linked Admin Quest detail use
 * these rows as their source. Notify in the same transaction as each write so
 * rollback and idempotent replay do not publish a stale invalidation.
 */
const notifyAdminDisputeCaseViewsUpdated = async (
  transaction: WalletTransaction,
  record: Pick<typeof adminDisputeCase.$inferSelect, 'id' | 'questId'>,
  walletIds: string[] = []
) => {
  await notifyAdminResourceUpdated(transaction, 'DISPUTE_CASE', record.id);
  await notifyAdminResourceUpdated(transaction, 'QUEST', record.questId);
  await Promise.all(
    [...new Set(walletIds)].map((walletId) =>
      notifyAdminResourceUpdated(transaction, 'WALLET', walletId)
    )
  );
};

/** Rulebook: Hirer/Worker self-file within 1 day of failure; Admin on a Worker's behalf within 5. */
const disputeFilingWindowMs = (adminOpened: boolean) =>
  adminOpened ? 5 * dayMs : disputeSelfFileWindowMs;
export type DisputeCaseStatus = (typeof disputeCaseStatuses)[number];
export type DisputeCaseOutcome = 'DISPUTE_CASE_DISMISSED' | 'DISPUTE_CASE_RESOLVED';

const adminActionService = createAdminActionService(disputeAdminActionCatalog);
const maxDisputeEvidenceAssignments = 100;
const maxDisputeEvidenceProofSubmissions = 100;
const maxDisputeEvidenceFiles = 5;

export class AdminDisputeCaseError extends Error {
  readonly code:
    | 'DISPUTE_CASE_NOT_FOUND'
    | 'DISPUTE_CASE_NOT_PENDING'
    | 'DISPUTE_CASE_QUEST_NOT_FAILED'
    | 'DISPUTE_CASE_WORKER_NOT_ASSIGNED'
    | 'DISPUTE_CASE_ASSIGNMENT_COMPLETED'
    | 'DISPUTE_CASE_TEAM_LEADER_ONLY'
    | 'DISPUTE_CASE_RESERVATION_NOT_FOUND'
    | 'DISPUTE_CASE_OUTCOME_INVALID'
    | 'DISPUTE_CASE_AMOUNT_EXCEEDS_HOLD'
    | 'DISPUTE_CASE_WINDOW_EXPIRED'
    | 'DISPUTE_CASE_RESPONDENT_NOT_ALLOWED'
    | 'DISPUTE_CASE_RESPONSE_WINDOW_EXPIRED'
    | 'DISPUTE_CASE_RESPONSE_ALREADY_SUBMITTED';

  constructor(code: AdminDisputeCaseError['code'], message: string) {
    super(message);
    this.name = 'AdminDisputeCaseError';
    this.code = code;
  }
}

export type AdminDisputeCaseSummary = {
  id: string;
  displayId: string;
  questId: string;
  filerUserId: string;
  /** The selected Candidate Team a team-leader filing covers; null otherwise. */
  teamId: string | null;
  openedByAdminId: string | null;
  status: DisputeCaseStatus;
  category: DisputeCaseCategory | null;
  version: number;
  resolvedWorkerId: string | null;
  resolvedAmountSatang: number | null;
  resolvedByAdminId: string | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AdminDisputeCaseDetail = AdminDisputeCaseSummary &
  AdminMemberModerationContextFields & {
    category: DisputeCaseCategory | null;
    submittedDetail: string | null;
    filerStatement: string | null;
    respondentStatement: string | null;
    filerDisplayId: string | null;
    respondentDisplayId: string | null;
    member: { status: AdminMemberStatus } | null;
    resolvedWorkerDisplayId: string | null;
    decision: {
      reasonCode: string | null;
      decisionReasonText: string | null;
    };
    quest: {
      id: string;
      displayId: string | null;
      title: string;
      hirerId: string;
      hirerDisplayId: string | null;
      questStatus: string;
      version: number;
      failedAt: string | null;
      fundingReservationId: string | null;
    };
  };

export type AdminDisputeEvidence = {
  caseId: string;
  questId: string;
  truncated: boolean;
  quest: {
    id: string;
    questStatus: string;
    version: number;
    hirerId: string;
    failedAt: string | null;
  };
  assignments: Array<{
    id: string;
    workerId: string;
    assignmentStatus: string;
    startedAt: string | null;
    createdAt: string;
  }>;
  proofSubmissions: Array<{
    id: string;
    workerId: string | null;
    teamId: string | null;
    submittedByUserId: string;
    workerMessage: string | null;
    submissionStatus: string;
    submittedAt: string | null;
    files: Array<{
      fileId: string;
      contentType: string;
      sizeBytes: number;
      position: number;
      url: string;
      urlExpiresAt: string;
    }>;
  }>;
};

export type ListAdminDisputeCasesInput = {
  q?: string;
  status?: DisputeCaseStatus;
  limit?: number;
  cursor?: CursorPayload;
  sort?: 'newest' | 'oldest';
};

export type ResolveAdminDisputeCaseInput = {
  adminId: string;
  disputeCaseId: string;
  expectedVersion: number;
  requestKey: string;
  reasonCode: DisputeCaseDismissReasonCode | DisputeCaseResolveReasonCode;
  decisionReasonText?: string;
  outcome: DisputeCaseOutcome;
  workerId?: string;
  amountSatang?: number;
  now?: Date | (() => Date);
};

export type CreateAdminDisputeCaseInput = {
  questId: string;
  filerUserId: string;
  category: DisputeCaseCategory;
  submittedDetail: string;
  filerStatement?: string;
  openedByAdminId?: string;
  now?: Date;
};

export type SubmitDisputeCaseResponseInput = {
  disputeCaseId: string;
  respondentUserId: string;
  respondentStatement: string;
  now?: Date;
};

export type ResolveAdminDisputeCaseResult = AdminActionResult<AdminDisputeCaseSummary> & {
  outcome: DisputeCaseOutcome;
};

const serializeDate = (value: Date | null): string | null => value?.toISOString() ?? null;

export const summaryFromRecord = (
  record: typeof adminDisputeCase.$inferSelect
): AdminDisputeCaseSummary => ({
  id: record.id,
  displayId: formatDisputeDisplayId(record.publicSequence),
  questId: record.questId,
  filerUserId: record.filerUserId,
  teamId: record.teamId,
  openedByAdminId: record.openedByAdminId,
  status: record.status,
  category: record.category,
  version: record.version,
  resolvedWorkerId: record.resolvedWorkerId,
  resolvedAmountSatang: record.resolvedAmountSatang,
  resolvedByAdminId: record.resolvedByAdminId,
  resolvedAt: serializeDate(record.resolvedAt),
  createdAt: record.createdAt.toISOString(),
  updatedAt: record.updatedAt.toISOString(),
});

const caseByIdInTransaction = async (
  transaction: WalletTransaction,
  disputeCaseId: string,
  lock = false
) => {
  const query = transaction
    .select()
    .from(adminDisputeCase)
    .where(eq(adminDisputeCase.id, disputeCaseId));
  const [record] = lock ? await query.for('update') : await query.limit(1);
  return record;
};

type DisputeNotificationCase = typeof adminDisputeCase.$inferSelect;

/**
 * Members on each side of a Dispute Case. The respondent rule matches the response rule:
 * when the Hirer files, every Worker with an Assignment on the Quest is a respondent;
 * when a Worker files, the Hirer is the respondent. The filer side adds the Candidate Team
 * members of a team case, because the Team Leader files for the whole team.
 */
const disputeSidesInTransaction = async (
  transaction: WalletTransaction,
  disputeCase: DisputeNotificationCase
) => {
  const [questRow] = await transaction
    .select({ hirerId: quest.hirerId, title: quest.title })
    .from(quest)
    .where(eq(quest.id, disputeCase.questId))
    .limit(1);
  if (!questRow) return undefined;
  const filerSide = new Set<string>([disputeCase.filerUserId]);
  const respondentSide = new Set<string>();
  if (disputeCase.filerUserId === questRow.hirerId) {
    const assignments = await transaction
      .select({ workerId: questAssignment.workerId })
      .from(questAssignment)
      .where(eq(questAssignment.questId, disputeCase.questId));
    for (const { workerId } of assignments) respondentSide.add(workerId);
    const team = await readSelectedTeam(transaction, disputeCase.questId);
    if (team) {
      const roster = await transaction
        .select({ memberId: questCandidateTeamV2Member.memberId })
        .from(questCandidateTeamV2Member)
        .where(eq(questCandidateTeamV2Member.teamId, team.id));
      for (const { memberId } of roster) respondentSide.add(memberId);
    }
  } else {
    respondentSide.add(questRow.hirerId);
    if (disputeCase.teamId) {
      const roster = await transaction
        .select({ memberId: questCandidateTeamV2Member.memberId })
        .from(questCandidateTeamV2Member)
        .where(eq(questCandidateTeamV2Member.teamId, disputeCase.teamId));
      for (const { memberId } of roster) filerSide.add(memberId);
    }
  }
  for (const memberId of filerSide) respondentSide.delete(memberId);
  return { hirerId: questRow.hirerId, questTitle: questRow.title, filerSide, respondentSide };
};

/** Inbox row only, no Push: tells each respondent that a Dispute Case was filed against them. */
const recordDisputeFiledNotifications = async (
  transaction: WalletTransaction,
  disputeCase: DisputeNotificationCase,
  now: Date
) => {
  const sides = await disputeSidesInTransaction(transaction, disputeCase);
  if (!sides) return;
  for (const memberId of sides.respondentSide) {
    await insertMemberNotificationInTransaction(transaction, {
      memberId,
      type: 'DISPUTE_CASE_FILED_AGAINST_YOU',
      eventKey: `dispute-filed:${disputeCase.id}:${memberId}`,
      questId: disputeCase.questId,
      questTitle: sides.questTitle,
      disputeCaseId: disputeCase.id,
      actorRole: memberId === sides.hirerId ? 'HIRER' : 'WORKER',
      now,
    });
  }
};

/**
 * Inbox row only, no Push: tells the filer side and the respondent side of a decided case.
 * `viewerWon` is the server answer for each recipient. The filer side wins a resolved case and
 * loses a dismissed case. The respondent side gets the opposite. It never carries the amount,
 * the Admin note, the filed reason, or the other party.
 */
const recordDisputeDecidedNotifications = async (
  transaction: WalletTransaction,
  disputeCase: DisputeNotificationCase,
  disputeStatus: 'DISPUTE_CASE_DISMISSED' | 'DISPUTE_CASE_RESOLVED',
  now: Date
) => {
  const sides = await disputeSidesInTransaction(transaction, disputeCase);
  if (!sides) return;
  const filerWon = disputeStatus === 'DISPUTE_CASE_RESOLVED';
  const recipients = [
    ...[...sides.filerSide].map((memberId) => ({ memberId, viewerWon: filerWon })),
    ...[...sides.respondentSide].map((memberId) => ({ memberId, viewerWon: !filerWon })),
  ];
  for (const { memberId, viewerWon } of recipients) {
    await insertMemberNotificationInTransaction(transaction, {
      memberId,
      type: 'DISPUTE_CASE_DECIDED',
      eventKey: `dispute-decided:${disputeCase.id}:${memberId}`,
      questId: disputeCase.questId,
      questTitle: sides.questTitle,
      disputeCaseId: disputeCase.id,
      disputeStatus,
      actorRole: memberId === sides.hirerId ? 'HIRER' : 'WORKER',
      viewerWon,
      now,
    });
  }
};

/** Create the queue record after a filing adapter has authenticated its actor. */
/** A selected Candidate Team has one outcome, so only its Team Leader can file a Dispute Case. */
const isSelectedTeamMemberOnly = async (
  reader: typeof db | WalletTransaction,
  questId: string,
  memberId: string
) => {
  const [team] = await reader
    .select({ leaderId: questCandidateTeamV2.leaderId })
    .from(questCandidateTeamV2)
    .where(
      and(
        eq(questCandidateTeamV2.questId, questId),
        eq(questCandidateTeamV2.state, 'TEAM_SELECTED')
      )
    )
    .limit(1);
  return team !== undefined && team.leaderId !== memberId;
};

export const createAdminDisputeCaseInTransaction = async (
  transaction: WalletTransaction,
  input: CreateAdminDisputeCaseInput
) => {
  const now = input.now ?? new Date();
  const [existing] = await transaction
    .select()
    .from(adminDisputeCase)
    .where(
      and(
        eq(adminDisputeCase.questId, input.questId),
        eq(adminDisputeCase.filerUserId, input.filerUserId)
      )
    )
    .for('update');
  if (
    existing &&
    ((existing.category !== null && existing.submittedDetail !== null) ||
      existing.status !== 'DISPUTE_CASE_PENDING')
  )
    return existing;

  const [currentQuest] = await transaction
    .select({
      id: quest.id,
      hirerId: quest.hirerId,
      moneyHoldStartedAt: quest.moneyHoldStartedAt,
    })
    .from(quest)
    .where(eq(quest.id, input.questId))
    .for('update');
  if (!currentQuest || !isMoneyHoldOpen(currentQuest)) {
    throw new AdminDisputeCaseError(
      'DISPUTE_CASE_QUEST_NOT_FAILED',
      'Only a Quest with a money hold can receive a Dispute Case.'
    );
  }

  const filingWindow = disputeFilingWindowMs(Boolean(input.openedByAdminId));
  if (now.getTime() > currentQuest.moneyHoldStartedAt.getTime() + filingWindow) {
    throw new AdminDisputeCaseError(
      'DISPUTE_CASE_WINDOW_EXPIRED',
      'The Dispute Case filing window has expired.'
    );
  }
  if (input.openedByAdminId && input.filerUserId === currentQuest.hirerId) {
    throw new AdminDisputeCaseError(
      'DISPUTE_CASE_WORKER_NOT_ASSIGNED',
      'An Admin may open a Dispute Case only on behalf of a Worker.'
    );
  }
  let filingTeamId: string | null = null;
  if (input.filerUserId !== currentQuest.hirerId) {
    const team = await readSelectedTeam(transaction, input.questId);
    if (team) {
      const [membership] = await transaction
        .select({ memberId: questCandidateTeamV2Member.memberId })
        .from(questCandidateTeamV2Member)
        .where(
          and(
            eq(questCandidateTeamV2Member.teamId, team.id),
            eq(questCandidateTeamV2Member.memberId, input.filerUserId)
          )
        )
        .limit(1);
      if (!membership) {
        throw new AdminDisputeCaseError(
          'DISPUTE_CASE_WORKER_NOT_ASSIGNED',
          'The filer did not hold an Assignment on this Quest.'
        );
      }
      if (team.leaderId !== input.filerUserId) {
        throw new AdminDisputeCaseError(
          'DISPUTE_CASE_TEAM_LEADER_ONLY',
          'Only the Candidate Team Leader may file a Dispute Case for the team.'
        );
      }
      filingTeamId = team.id;
    }
    const [assignment] = await transaction
      .select({ id: questAssignment.id, status: questAssignment.assignmentStatus })
      .from(questAssignment)
      .where(
        and(
          eq(questAssignment.questId, input.questId),
          eq(questAssignment.workerId, input.filerUserId)
        )
      )
      .limit(1);
    if (!assignment) {
      throw new AdminDisputeCaseError(
        'DISPUTE_CASE_WORKER_NOT_ASSIGNED',
        'The filer did not hold an Assignment on this Quest.'
      );
    }
    if (assignment.status === 'ASSIGNMENT_COMPLETED') {
      throw new AdminDisputeCaseError(
        'DISPUTE_CASE_ASSIGNMENT_COMPLETED',
        'The filer already received the Quest Reward, so the filer has nothing to dispute.'
      );
    }
    if (await isSelectedTeamMemberOnly(transaction, input.questId, input.filerUserId)) {
      throw new AdminDisputeCaseError(
        'DISPUTE_CASE_TEAM_LEADER_ONLY',
        'Only the Team Leader can file a Dispute Case for a Candidate Team.'
      );
    }
  }

  const [created] = existing
    ? await transaction
        .update(adminDisputeCase)
        .set({
          teamId: filingTeamId,
          category: input.category,
          submittedDetail: input.submittedDetail,
          filerStatement: existing.filerStatement ?? input.filerStatement ?? null,
          openedByAdminId: input.openedByAdminId ?? existing.openedByAdminId,
          version: sql`${adminDisputeCase.version} + 1`,
          updatedAt: now,
        })
        .where(
          and(
            eq(adminDisputeCase.id, existing.id),
            eq(adminDisputeCase.status, 'DISPUTE_CASE_PENDING')
          )
        )
        .returning()
    : await transaction
        .insert(adminDisputeCase)
        .values({
          questId: input.questId,
          filerUserId: input.filerUserId,
          openedByAdminId: input.openedByAdminId,
          teamId: filingTeamId,
          category: input.category,
          submittedDetail: input.submittedDetail,
          filerStatement: input.filerStatement ?? null,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing({
          target: [adminDisputeCase.questId, adminDisputeCase.filerUserId],
        })
        .returning();
  if (created) {
    await recordDisputeFiledNotifications(transaction, created, now);
    await notifyDisputeCaseUpdated(transaction, created);
    await notifyAdminDisputeCaseViewsUpdated(transaction, created);
    return created;
  }
  const [concurrent] = await transaction
    .select()
    .from(adminDisputeCase)
    .where(
      and(
        eq(adminDisputeCase.questId, input.questId),
        eq(adminDisputeCase.filerUserId, input.filerUserId)
      )
    )
    .limit(1);
  if (!concurrent)
    throw new AdminDisputeCaseError('DISPUTE_CASE_NOT_FOUND', 'Dispute Case could not be created.');
  return concurrent;
};

export const createAdminDisputeCase = async (input: CreateAdminDisputeCaseInput) =>
  db.transaction((transaction) => createAdminDisputeCaseInTransaction(transaction, input));

export const disputeDecisionWindowExpiredSql = (now: Date) =>
  sql<boolean>`${adminDisputeCase.createdAt} + ${disputeDecisionWindowMs} * interval '1 millisecond' <= ${now.toISOString()}::timestamptz`;

const dismissOverdueDisputeCaseInTransaction = async (
  transaction: WalletTransaction,
  disputeCaseId: string,
  readNow: Date | (() => Date)
) => {
  const [row] = await transaction
    .select({ disputeCase: adminDisputeCase })
    .from(adminDisputeCase)
    .where(eq(adminDisputeCase.id, disputeCaseId))
    .for('update');
  const now = typeof readNow === 'function' ? readNow() : readNow;
  if (!row) {
    return { changed: false, systemDismissed: false, notFound: true, checkedAt: now } as const;
  }
  if (row.disputeCase.status !== 'DISPUTE_CASE_PENDING') {
    return {
      changed: false,
      systemDismissed:
        row.disputeCase.status === 'DISPUTE_CASE_DISMISSED' &&
        row.disputeCase.resolvedByAdminId === null,
      notFound: false,
      checkedAt: now,
    } as const;
  }
  const [deadline] = await transaction
    .select({ decisionWindowExpired: disputeDecisionWindowExpiredSql(now) })
    .from(adminDisputeCase)
    .where(eq(adminDisputeCase.id, disputeCaseId));
  if (!deadline?.decisionWindowExpired) {
    return { changed: false, systemDismissed: false, notFound: false, checkedAt: now } as const;
  }

  const [updated] = await transaction
    .update(adminDisputeCase)
    .set({
      status: 'DISPUTE_CASE_DISMISSED',
      resolvedByAdminId: null,
      resolvedAt: now,
      version: sql`${adminDisputeCase.version} + 1`,
      updatedAt: now,
    })
    .where(
      and(
        eq(adminDisputeCase.id, disputeCaseId),
        eq(adminDisputeCase.status, 'DISPUTE_CASE_PENDING'),
        disputeDecisionWindowExpiredSql(now)
      )
    )
    .returning();
  if (!updated) {
    return { changed: false, systemDismissed: false, notFound: false, checkedAt: now } as const;
  }

  await recordAudit(transaction, {
    actorType: 'SYSTEM',
    action: 'DISPUTE_CASE_AUTO_DISMISSED',
    resourceType: 'DISPUTE_CASE',
    resourceId: updated.id,
    oldValue: { status: row.disputeCase.status },
    newValue: { status: updated.status },
    reason: 'The 7-day Dispute Case decision window expired.',
    createdAt: now,
  });
  await recordDisputeDecidedNotifications(transaction, updated, 'DISPUTE_CASE_DISMISSED', now);
  await notifyDisputeCaseUpdated(transaction, updated);
  await notifyAdminDisputeCaseViewsUpdated(transaction, updated);
  return { changed: true, systemDismissed: true, notFound: false, checkedAt: now } as const;
};

/** Dismiss one pending Dispute Case when its decision window has ended. */
export const autoDismissOverdueDisputeCase = async (disputeCaseId: string, now = new Date()) =>
  db.transaction(async (transaction) => {
    const result = await dismissOverdueDisputeCaseInTransaction(transaction, disputeCaseId, now);
    return result.changed;
  });

export const submitDisputeCaseResponse = async ({
  disputeCaseId,
  respondentUserId,
  respondentStatement,
  now = new Date(),
}: SubmitDisputeCaseResponseInput) =>
  db.transaction(async (transaction) => {
    const [row] = await transaction
      .select({
        disputeCase: adminDisputeCase,
        quest: {
          id: quest.id,
          hirerId: quest.hirerId,
          moneyHoldStartedAt: quest.moneyHoldStartedAt,
        },
      })
      .from(adminDisputeCase)
      .innerJoin(quest, eq(quest.id, adminDisputeCase.questId))
      .where(eq(adminDisputeCase.id, disputeCaseId))
      .for('update');
    if (!row)
      throw new AdminDisputeCaseError('DISPUTE_CASE_NOT_FOUND', 'Dispute Case does not exist.');
    if (!isMoneyHoldOpen(row.quest)) {
      throw new AdminDisputeCaseError(
        'DISPUTE_CASE_QUEST_NOT_FAILED',
        'A response is only available while the Quest has a money hold.'
      );
    }
    if (row.disputeCase.status !== 'DISPUTE_CASE_PENDING') {
      throw new AdminDisputeCaseError(
        'DISPUTE_CASE_NOT_PENDING',
        'A response is only available while the Dispute Case is pending.'
      );
    }

    if (now.getTime() > row.quest.moneyHoldStartedAt.getTime() + moneyHoldDurationMs) {
      throw new AdminDisputeCaseError(
        'DISPUTE_CASE_RESPONSE_WINDOW_EXPIRED',
        'The Dispute Case response window has expired.'
      );
    }

    let isRespondent = false;
    if (row.disputeCase.filerUserId === row.quest.hirerId) {
      const [assignment] = await transaction
        .select({ id: questAssignment.id })
        .from(questAssignment)
        .where(
          and(
            eq(questAssignment.questId, row.disputeCase.questId),
            eq(questAssignment.workerId, respondentUserId)
          )
        )
        .limit(1);
      isRespondent = assignment !== undefined;
    } else {
      isRespondent = respondentUserId === row.quest.hirerId;
    }
    if (!isRespondent || respondentUserId === row.disputeCase.filerUserId) {
      throw new AdminDisputeCaseError(
        'DISPUTE_CASE_RESPONDENT_NOT_ALLOWED',
        'Only the other Member in this Dispute Case may submit a response.'
      );
    }

    if (row.disputeCase.respondentStatement !== null) {
      if (
        row.disputeCase.respondentUserId === respondentUserId &&
        row.disputeCase.respondentStatement === respondentStatement
      )
        return summaryFromRecord(row.disputeCase);
      throw new AdminDisputeCaseError(
        'DISPUTE_CASE_RESPONSE_ALREADY_SUBMITTED',
        'A respondent statement has already been submitted.'
      );
    }

    const [updated] = await transaction
      .update(adminDisputeCase)
      .set({
        respondentUserId,
        respondentStatement,
        version: sql`${adminDisputeCase.version} + 1`,
        updatedAt: now,
      })
      .where(
        and(
          eq(adminDisputeCase.id, disputeCaseId),
          eq(adminDisputeCase.status, 'DISPUTE_CASE_PENDING')
        )
      )
      .returning();
    if (!updated) {
      throw new AdminDisputeCaseError(
        'DISPUTE_CASE_NOT_PENDING',
        'Dispute Case changed before the response was submitted.'
      );
    }
    await notifyDisputeCaseUpdated(transaction, updated);
    await notifyAdminDisputeCaseViewsUpdated(transaction, updated);
    return summaryFromRecord(updated);
  });

export const listAdminDisputeCases = async ({
  q,
  status = 'DISPUTE_CASE_PENDING',
  limit = 20,
  cursor,
  sort = 'newest',
}: ListAdminDisputeCasesInput = {}) => {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new CursorInputError('INVALID_LIMIT', 'Dispute Case limit must be between 1 and 50.');
  }

  const searchPattern = containsLikeQueryPattern(q);
  const search = searchPattern
    ? or(
        adminListSearchValue(sql`${adminDisputeCase.id}::text`, searchPattern),
        adminListSearchValue(
          formatDisplayIdSql('dispute', adminDisputeCase.publicSequence),
          searchPattern
        ),
        adminListSearchValue(sql`${adminDisputeCase.questId}::text`, searchPattern),
        adminListSearchValue(sql`${adminDisputeCase.filerUserId}::text`, searchPattern),
        adminListSearchValue(sql`${adminDisputeCase.openedByAdminId}::text`, searchPattern),
        adminListSearchValue(adminDisputeCase.status, searchPattern),
        adminListSearchValue(sql`${adminDisputeCase.version}::text`, searchPattern),
        adminListSearchValue(sql`${adminDisputeCase.resolvedWorkerId}::text`, searchPattern),
        adminListSearchValue(sql`${adminDisputeCase.resolvedAmountSatang}::text`, searchPattern),
        adminListSearchValue(sql`${adminDisputeCase.resolvedByAdminId}::text`, searchPattern),
        adminListSearchValue(adminListSearchDate(adminDisputeCase.resolvedAt), searchPattern),
        adminListSearchValue(adminListSearchDate(adminDisputeCase.createdAt), searchPattern),
        adminListSearchValue(adminListSearchDate(adminDisputeCase.updatedAt), searchPattern)
      )
    : undefined;
  const [page, statusRows] = await Promise.all([
    readKeysetPage({
      anchor: { time: adminDisputeCase.createdAt, id: adminDisputeCase.id },
      cursor,
      limit,
      sort,
      where: and(search, eq(adminDisputeCase.status, status)),
      read: ({ where, orderBy, limit: probe }) =>
        db
          .select()
          .from(adminDisputeCase)
          .where(where)
          .orderBy(...orderBy)
          .limit(probe),
      rowCursor: (row) => ({ startTime: row.createdAt, id: row.id }),
      invalidCursor: () => new CursorInputError('INVALID_CURSOR', 'Dispute cursor is invalid.'),
    }),
    db
      .select({ status: adminDisputeCase.status, count: count() })
      .from(adminDisputeCase)
      .where(search)
      .groupBy(adminDisputeCase.status),
  ]);

  const countsByStatus = buildStatusCounts(disputeCaseStatuses, statusRows);

  return {
    items: page.rows.map(summaryFromRecord),
    nextCursor: page.nextCursor,
    totalCount: countsByStatus[status],
    countsByStatus,
  };
};

export const getAdminDisputeCase = async (
  disputeCaseId: string
): Promise<AdminDisputeCaseDetail> => {
  const [row] = await db
    .select({
      disputeCase: adminDisputeCase,
      caseCreatedAt: sql<string>`to_char(${adminDisputeCase.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
      quest: {
        id: quest.id,
        publicSequence: quest.publicSequence,
        title: quest.title,
        hirerId: quest.hirerId,
        questStatus: quest.questStatus,
        version: quest.version,
        failedAt: quest.failedAt,
        fundingReservationId: quest.fundingReservationId,
      },
      filerDisplayId: sql<string | null>`(
        SELECT ${formatDisplayIdSql('member', authUser.publicSequence)}
        FROM ${authUser}
        WHERE ${authUser.id} = ${adminDisputeCase.filerUserId}
        LIMIT 1
      )`,
      respondentDisplayId: sql<string | null>`(
        SELECT ${formatDisplayIdSql('member', authUser.publicSequence)}
        FROM ${authUser}
        WHERE ${authUser.id} = ${adminDisputeCase.respondentUserId}
        LIMIT 1
      )`,
      resolvedWorkerDisplayId: sql<string | null>`(
        SELECT ${formatDisplayIdSql('member', authUser.publicSequence)}
        FROM ${authUser}
        WHERE ${authUser.id} = ${adminDisputeCase.resolvedWorkerId}
        LIMIT 1
      )`,
      hirerDisplayId: sql<string | null>`(
        SELECT ${formatDisplayIdSql('member', authUser.publicSequence)}
        FROM ${authUser}
        WHERE ${authUser.id} = ${quest.hirerId}
        LIMIT 1
      )`,
    })
    .from(adminDisputeCase)
    .innerJoin(quest, eq(quest.id, adminDisputeCase.questId))
    .where(eq(adminDisputeCase.id, disputeCaseId))
    .limit(1);
  if (!row)
    throw new AdminDisputeCaseError('DISPUTE_CASE_NOT_FOUND', 'Dispute Case does not exist.');
  let respondentUserId = row.disputeCase.respondentUserId;
  if (!respondentUserId) {
    if (row.disputeCase.filerUserId === row.quest.hirerId) {
      if (row.disputeCase.resolvedWorkerId) {
        respondentUserId = row.disputeCase.resolvedWorkerId;
      } else {
        const assignedWorkers = await db
          .select({ workerId: questAssignment.workerId })
          .from(questAssignment)
          .where(eq(questAssignment.questId, row.quest.id))
          .limit(2);
        if (assignedWorkers.length === 1) respondentUserId = assignedWorkers[0]!.workerId;
      }
    } else {
      respondentUserId = row.quest.hirerId;
    }
  }
  const moderationContext = await getAdminMemberModerationContext(
    respondentUserId,
    row.caseCreatedAt
  );
  const [decision] = await db
    .select({
      reasonCode: adminAction.reasonCode,
      decisionReasonText: adminAction.decisionReasonText,
    })
    .from(adminAction)
    .where(
      and(
        eq(adminAction.resourceType, 'dispute_case'),
        eq(adminAction.resourceId, disputeCaseId),
        or(
          eq(adminAction.action, 'DISPUTE_CASE_DISMISS'),
          eq(adminAction.action, 'DISPUTE_CASE_RESOLVE')
        )
      )
    )
    .orderBy(desc(adminAction.createdAt), desc(adminAction.id))
    .limit(1);
  return {
    ...summaryFromRecord(row.disputeCase),
    category: row.disputeCase.category,
    submittedDetail: row.disputeCase.submittedDetail,
    filerStatement: row.disputeCase.filerStatement,
    respondentStatement: row.disputeCase.respondentStatement,
    filerDisplayId: row.filerDisplayId,
    respondentDisplayId: row.respondentDisplayId,
    ...moderationContext,
    member: moderationContext.memberStatus ? { status: moderationContext.memberStatus } : null,
    resolvedWorkerDisplayId: row.resolvedWorkerDisplayId,
    decision: {
      reasonCode: decision?.reasonCode ?? null,
      decisionReasonText: decision?.decisionReasonText ?? null,
    },
    quest: {
      ...row.quest,
      displayId: formatQuestDisplayId(row.quest.publicSequence),
      hirerDisplayId: row.hirerDisplayId,
      failedAt: serializeDate(row.quest.failedAt),
    },
  };
};

const evidenceForCaseInTransaction = async (
  transaction: WalletTransaction,
  disputeCaseId: string
): Promise<AdminDisputeEvidence> => {
  const [caseRow] = await transaction
    .select({
      id: adminDisputeCase.id,
      questId: adminDisputeCase.questId,
    })
    .from(adminDisputeCase)
    .where(eq(adminDisputeCase.id, disputeCaseId))
    .limit(1);
  if (!caseRow)
    throw new AdminDisputeCaseError('DISPUTE_CASE_NOT_FOUND', 'Dispute Case does not exist.');

  const [questRow] = await transaction
    .select({
      id: quest.id,
      questStatus: quest.questStatus,
      version: quest.version,
      hirerId: quest.hirerId,
      failedAt: quest.failedAt,
    })
    .from(quest)
    .where(eq(quest.id, caseRow.questId))
    .limit(1);
  if (!questRow)
    throw new AdminDisputeCaseError('DISPUTE_CASE_NOT_FOUND', 'Dispute Quest does not exist.');

  const assignments = await transaction
    .select({
      id: questAssignment.id,
      workerId: questAssignment.workerId,
      assignmentStatus: questAssignment.assignmentStatus,
      startedAt: questAssignment.startedAt,
      createdAt: questAssignment.createdAt,
    })
    .from(questAssignment)
    .where(eq(questAssignment.questId, caseRow.questId))
    .orderBy(asc(questAssignment.createdAt), asc(questAssignment.id))
    .limit(maxDisputeEvidenceAssignments + 1);
  const assignmentsTruncated = assignments.length > maxDisputeEvidenceAssignments;

  const legacyProofRows = await transaction
    .select({
      id: proofSubmission.id,
      workerId: proofSubmission.workerId,
      teamId: proofSubmission.teamId,
      submittedByUserId: proofSubmission.submittedByUserId,
      workerMessage: sql<string | null>`NULL`,
      submissionStatus: proofSubmission.submissionStatus,
      submittedAt: proofSubmission.submittedAt,
      fileId: proofSubmissionImage.fileId,
      contentType: file.contentType,
      sizeBytes: file.sizeBytes,
      position: proofSubmissionImage.position,
      bucket: file.bucket,
      objectKey: file.objectKey,
    })
    .from(proofSubmission)
    .leftJoin(proofSubmissionImage, eq(proofSubmissionImage.proofSubmissionId, proofSubmission.id))
    .leftJoin(file, eq(file.id, proofSubmissionImage.fileId))
    .where(eq(proofSubmission.questId, caseRow.questId))
    .orderBy(
      asc(proofSubmission.submittedAt),
      asc(proofSubmission.id),
      asc(proofSubmissionImage.position)
    )
    .limit(maxDisputeEvidenceProofSubmissions + 1);
  const v2ProofRows = await transaction
    .select({
      id: questV2ProofSubmission.id,
      workerId: questV2ProofSubmission.workerId,
      teamId: questV2ProofSubmission.teamId,
      submittedByUserId: questV2ProofSubmission.submittedByUserId,
      workerMessage: questV2ProofSubmission.workerMessage,
      submissionStatus: questV2ProofSubmission.submissionStatus,
      submittedAt: questV2ProofSubmission.sentAt,
      fileId: questV2ProofSubmissionFile.fileId,
      contentType: file.contentType,
      sizeBytes: file.sizeBytes,
      position: questV2ProofSubmissionFile.position,
      bucket: file.bucket,
      objectKey: file.objectKey,
    })
    .from(questV2ProofSubmission)
    .leftJoin(
      questV2ProofSubmissionFile,
      eq(questV2ProofSubmissionFile.proofSubmissionId, questV2ProofSubmission.id)
    )
    .leftJoin(file, eq(file.id, questV2ProofSubmissionFile.fileId))
    .where(eq(questV2ProofSubmission.questId, caseRow.questId))
    .orderBy(
      asc(questV2ProofSubmission.sentAt),
      asc(questV2ProofSubmission.id),
      asc(questV2ProofSubmissionFile.position)
    )
    .limit(maxDisputeEvidenceProofSubmissions + 1);

  const proofSubmissions = new Map<string, AdminDisputeEvidence['proofSubmissions'][number]>();
  for (const row of [...legacyProofRows, ...v2ProofRows]) {
    const proof = proofSubmissions.get(row.id) ?? {
      id: row.id,
      workerId: row.workerId,
      teamId: row.teamId,
      submittedByUserId: row.submittedByUserId,
      workerMessage: row.workerMessage,
      submissionStatus: row.submissionStatus ?? 'PROOF_DRAFT',
      submittedAt: serializeDate(row.submittedAt),
      files: [],
    };
    if (
      row.fileId &&
      row.contentType &&
      row.sizeBytes !== null &&
      row.position !== null &&
      row.bucket &&
      row.objectKey
    ) {
      const link = questV2ProofStorage.linkForWithExpiry({
        bucket: row.bucket,
        objectKey: row.objectKey,
      });
      proof.files.push({
        fileId: row.fileId,
        contentType: row.contentType,
        sizeBytes: row.sizeBytes,
        position: row.position,
        url: link.url,
        urlExpiresAt: link.expiresAt.toISOString(),
      });
    }
    proofSubmissions.set(row.id, proof);
  }
  const proofItems = [...proofSubmissions.values()];
  const proofSubmissionsTruncated =
    legacyProofRows.length > maxDisputeEvidenceProofSubmissions ||
    v2ProofRows.length > maxDisputeEvidenceProofSubmissions ||
    proofItems.length > maxDisputeEvidenceProofSubmissions;
  let filesTruncated = false;
  for (const proof of proofItems) {
    if (proof.files.length > maxDisputeEvidenceFiles) filesTruncated = true;
    proof.files = proof.files.slice(0, maxDisputeEvidenceFiles);
  }

  return {
    caseId: caseRow.id,
    questId: caseRow.questId,
    truncated: assignmentsTruncated || proofSubmissionsTruncated || filesTruncated,
    quest: {
      ...questRow,
      questStatus: questRow.questStatus,
      failedAt: serializeDate(questRow.failedAt),
    },
    assignments: assignments.slice(0, maxDisputeEvidenceAssignments).map((assignment) => ({
      ...assignment,
      startedAt: serializeDate(assignment.startedAt),
      createdAt: assignment.createdAt.toISOString(),
    })),
    proofSubmissions: proofItems.slice(0, maxDisputeEvidenceProofSubmissions),
  };
};

export const getAdminDisputeEvidence = async (
  adminId: string,
  disputeCaseId: string,
  requestKey: string
) => {
  const result = await adminActionService.recordEvidenceAccess({
    adminId,
    action: 'DISPUTE_CASE_EVIDENCE_ACCESS',
    resourceType: 'dispute_case',
    resourceId: disputeCaseId,
    requestKey,
    request: { view: 'case-scoped-evidence' },
    metadata: {},
    read: async (transaction) => ({
      resourceSummary: await evidenceForCaseInTransaction(transaction, disputeCaseId),
      resourceVersion: null,
      resourceTimestamp: null,
    }),
  });
  return {
    ...result.resourceSummary,
    adminActionId: result.adminActionId,
  };
};

const summaryResultInTransaction = async (
  transaction: WalletTransaction,
  disputeCaseId: string
): Promise<{
  resourceSummary: AdminDisputeCaseSummary;
  resourceVersion: number;
  resourceTimestamp: null;
}> => {
  const current = await caseByIdInTransaction(transaction, disputeCaseId);
  if (!current)
    throw new AdminDisputeCaseError('DISPUTE_CASE_NOT_FOUND', 'Dispute Case does not exist.');
  return {
    resourceSummary: summaryFromRecord(current),
    resourceVersion: current.version,
    resourceTimestamp: null,
  };
};

const assertResolutionInput = (input: ResolveAdminDisputeCaseInput) => {
  if (input.outcome === 'DISPUTE_CASE_DISMISSED') {
    if (input.workerId !== undefined || input.amountSatang !== undefined) {
      throw new AdminDisputeCaseError(
        'DISPUTE_CASE_OUTCOME_INVALID',
        'Dismissed Dispute Cases cannot include a Worker or an amount.'
      );
    }
    return;
  }
  if (input.outcome !== 'DISPUTE_CASE_RESOLVED') {
    throw new AdminDisputeCaseError(
      'DISPUTE_CASE_OUTCOME_INVALID',
      'Unsupported Dispute Case outcome.'
    );
  }
};

const resolveAdminDisputeCaseInTransaction = (
  decisionTransaction: WalletTransaction,
  input: ResolveAdminDisputeCaseInput,
  now: Date
) => {
  const action =
    input.outcome === 'DISPUTE_CASE_DISMISSED' ? 'DISPUTE_CASE_DISMISS' : 'DISPUTE_CASE_RESOLVE';
  const commandInput: AdminActionCommandInput<AdminDisputeCaseSummary> = {
    adminId: input.adminId,
    action,
    resourceType: 'dispute_case',
    resourceId: input.disputeCaseId,
    requestKey: input.requestKey,
    reasonCode: input.reasonCode,
    decisionReasonText: input.decisionReasonText,
    request: {
      outcome: input.outcome,
      workerId: input.workerId ?? null,
      amountSatang: input.amountSatang ?? null,
    },
    metadata: {},
    expectedVersion: input.expectedVersion,
    prepare: async (transaction) => {
      const current = await caseByIdInTransaction(transaction, input.disputeCaseId, true);
      if (!current)
        throw new AdminDisputeCaseError('DISPUTE_CASE_NOT_FOUND', 'Dispute Case does not exist.');

      return {
        currentVersion: current.version,
        apply: async () => {
          if (current.status !== 'DISPUTE_CASE_PENDING') {
            throw new AdminDisputeCaseError(
              'DISPUTE_CASE_NOT_PENDING',
              'Dispute Case has already reached a terminal status.'
            );
          }
          const [currentQuest] = await transaction
            .select({
              id: quest.id,
              hirerId: quest.hirerId,
              moneyHoldStartedAt: quest.moneyHoldStartedAt,
              fundingReservationId: quest.fundingReservationId,
            })
            .from(quest)
            .where(eq(quest.id, current.questId))
            .for('update');
          if (!currentQuest || !isMoneyHoldOpen(currentQuest)) {
            throw new AdminDisputeCaseError(
              'DISPUTE_CASE_QUEST_NOT_FAILED',
              'Only a Quest with a money hold can have a Dispute Case resolved.'
            );
          }
          const filingWindow = disputeFilingWindowMs(Boolean(current.openedByAdminId));
          if (
            current.createdAt.getTime() >
            currentQuest.moneyHoldStartedAt.getTime() + filingWindow
          ) {
            throw new AdminDisputeCaseError(
              'DISPUTE_CASE_WINDOW_EXPIRED',
              'Dispute Case was opened after its allowed filing window.'
            );
          }

          if (input.outcome === 'DISPUTE_CASE_DISMISSED') {
            const [updated] = await transaction
              .update(adminDisputeCase)
              .set({
                status: 'DISPUTE_CASE_DISMISSED',
                resolvedByAdminId: input.adminId,
                resolvedAt: now,
                version: sql`${adminDisputeCase.version} + 1`,
                updatedAt: now,
              })
              .where(
                and(
                  eq(adminDisputeCase.id, current.id),
                  eq(adminDisputeCase.version, input.expectedVersion),
                  eq(adminDisputeCase.status, 'DISPUTE_CASE_PENDING')
                )
              )
              .returning();
            if (!updated)
              throw new AdminDisputeCaseError(
                'DISPUTE_CASE_NOT_PENDING',
                'Dispute Case changed before dismissal.'
              );
            await recordDisputeDecidedNotifications(
              transaction,
              updated,
              'DISPUTE_CASE_DISMISSED',
              now
            );
            await notifyDisputeCaseUpdated(transaction, updated);
            await notifyAdminDisputeCaseViewsUpdated(transaction, updated);
            return summaryResultInTransaction(transaction, updated.id);
          }

          // A team case pays the whole Candidate Team: the Leader on record stands for it.
          const recipientWorkerId = current.teamId ? current.filerUserId : input.workerId;
          if (
            !recipientWorkerId ||
            (current.teamId && input.workerId && input.workerId !== recipientWorkerId)
          ) {
            throw new AdminDisputeCaseError(
              'DISPUTE_CASE_WORKER_NOT_ASSIGNED',
              current.teamId
                ? 'A team Dispute Case is decided for the Team Leader who filed it.'
                : 'A resolved Dispute Case must name a Worker.'
            );
          }
          const [assignment] = await transaction
            .select({ id: questAssignment.id, status: questAssignment.assignmentStatus })
            .from(questAssignment)
            .where(
              and(
                eq(questAssignment.questId, current.questId),
                eq(questAssignment.workerId, recipientWorkerId)
              )
            )
            .limit(1);
          if (!assignment) {
            throw new AdminDisputeCaseError(
              'DISPUTE_CASE_WORKER_NOT_ASSIGNED',
              'The named Worker did not hold an Assignment on this Quest.'
            );
          }
          if (assignment.status === 'ASSIGNMENT_COMPLETED') {
            throw new AdminDisputeCaseError(
              'DISPUTE_CASE_ASSIGNMENT_COMPLETED',
              'The named Worker already received the Quest Reward.'
            );
          }
          if (!currentQuest.fundingReservationId) {
            throw new AdminDisputeCaseError(
              'DISPUTE_CASE_RESERVATION_NOT_FOUND',
              'The failed Quest has no Funding Reservation.'
            );
          }

          // An Admin chooses no amount: a resolved case takes all the hold can still pay.
          const fullAmountSatang = await fullDisputeAmountSatang(transaction, {
            disputeCaseId: current.id,
            questId: current.questId,
            hirerId: currentQuest.hirerId,
            reservationId: currentQuest.fundingReservationId,
          });
          if (fullAmountSatang <= 0) {
            throw new AdminDisputeCaseError(
              'DISPUTE_CASE_AMOUNT_EXCEEDS_HOLD',
              'The Quest hold has no money left to pay.'
            );
          }
          let resolvedAmountSatang: number;
          if (current.teamId) {
            resolvedAmountSatang = positiveSatang(fullAmountSatang);
            const opened = await openTeamDisputeSplit(transaction, {
              disputeCase: current,
              hirerId: currentQuest.hirerId,
              reservationId: currentQuest.fundingReservationId,
              approvedAmountSatang: resolvedAmountSatang,
              now,
            });
            if (opened === 'exceeds-hold') {
              throw new AdminDisputeCaseError(
                'DISPUTE_CASE_AMOUNT_EXCEEDS_HOLD',
                'The approved amount is more than the Quest hold can still pay.'
              );
            }
          } else {
            const settlement = await settleDisputeCase(transaction, {
              ownerUserId: currentQuest.hirerId,
              reservationId: currentQuest.fundingReservationId,
              settlementReference: `dispute-case:${current.id}`,
              recipientUserId: recipientWorkerId,
              requestedAmountSatang: positiveSatang(fullAmountSatang),
            });
            resolvedAmountSatang = settlement.recipientAmountSatang;
          }
          const [updated] = await transaction
            .update(adminDisputeCase)
            .set({
              status: 'DISPUTE_CASE_RESOLVED',
              resolvedWorkerId: recipientWorkerId,
              resolvedAmountSatang,
              resolvedByAdminId: input.adminId,
              resolvedAt: now,
              version: sql`${adminDisputeCase.version} + 1`,
              updatedAt: now,
            })
            .where(
              and(
                eq(adminDisputeCase.id, current.id),
                eq(adminDisputeCase.version, input.expectedVersion),
                eq(adminDisputeCase.status, 'DISPUTE_CASE_PENDING')
              )
            )
            .returning();
          if (!updated)
            throw new AdminDisputeCaseError(
              'DISPUTE_CASE_NOT_PENDING',
              'Dispute Case changed before resolution.'
            );
          await recordDisputeDecidedNotifications(
            transaction,
            updated,
            'DISPUTE_CASE_RESOLVED',
            now
          );
          const affectedWallets = await transaction
            .select({ id: walletWallet.id })
            .from(walletWallet)
            .where(
              or(
                eq(walletWallet.userId, currentQuest.hirerId),
                eq(walletWallet.userId, recipientWorkerId)
              )
            )
            .orderBy(asc(walletWallet.id));
          await notifyDisputeCaseUpdated(transaction, updated);
          await notifyAdminDisputeCaseViewsUpdated(
            transaction,
            updated,
            affectedWallets.map(({ id }) => id)
          );
          return summaryResultInTransaction(transaction, updated.id);
        },
      };
    },
  };
  return adminActionService.executeCommandInTransaction<AdminDisputeCaseSummary>(
    decisionTransaction,
    commandInput
  );
};

export const resolveAdminDisputeCase = async (
  input: ResolveAdminDisputeCaseInput
): Promise<ResolveAdminDisputeCaseResult> => {
  assertResolutionInput(input);
  const result = await db.transaction(async (transaction) => {
    // Sample production time after the row lock so lock wait cannot make it stale.
    const deadline = await dismissOverdueDisputeCaseInTransaction(
      transaction,
      input.disputeCaseId,
      () => (typeof input.now === 'function' ? input.now() : input.now) ?? new Date()
    );
    if (deadline.notFound) return { outcome: 'not-found' } as const;
    if (deadline.systemDismissed) return { outcome: 'window-expired' } as const;
    return {
      outcome: 'decided',
      result: await resolveAdminDisputeCaseInTransaction(transaction, input, deadline.checkedAt),
    } as const;
  });

  if (result.outcome === 'not-found') {
    throw new AdminDisputeCaseError('DISPUTE_CASE_NOT_FOUND', 'Dispute Case does not exist.');
  }
  if (result.outcome === 'window-expired') {
    throw new AdminDisputeCaseError(
      'DISPUTE_CASE_WINDOW_EXPIRED',
      'The Dispute Case decision window has expired.'
    );
  }

  let resourceSummary = result.result.resourceSummary;
  if (!Object.prototype.hasOwnProperty.call(resourceSummary, 'category')) {
    const [persistedCase] = await db
      .select({ category: adminDisputeCase.category })
      .from(adminDisputeCase)
      .where(eq(adminDisputeCase.id, input.disputeCaseId))
      .limit(1);
    resourceSummary = { ...resourceSummary, category: persistedCase?.category ?? null };
  }
  return { ...result.result, resourceSummary, outcome: input.outcome };
};

export type QuestDisputeViewerRole = 'HIRER' | 'TEAM_LEADER' | 'TEAM_MEMBER' | 'WORKER';

type QuestDisputeCaseView = {
  id: string;
  displayId: string;
  status: DisputeCaseStatus;
  createdAt: Date;
};

export type QuestDisputeSummary = {
  canFile: boolean;
  windowEndsAt: Date | null;
  /** Which Dispute screen the app shows: the Team Leader files and splits, a Member only reads. */
  viewerRole: QuestDisputeViewerRole;
  myCase: QuestDisputeCaseView | null;
  /** The Candidate Team's case, visible to every Team member; null for any other Quest. */
  teamCase: QuestDisputeCaseView | null;
  /** The split state after the Admin approves a team case; null before that. */
  teamSplit: TeamDisputeSplitView | null;
};

/**
 * The viewer's Dispute view of a Quest. Null unless the Quest has a money hold.
 * `canFile` and `windowEndsAt` follow the self-file window used by `createAdminDisputeCase`.
 */
export const readQuestDisputeSummary = async (
  viewerId: string,
  questId: string,
  now = new Date()
): Promise<QuestDisputeSummary | null> => {
  const [row] = await db
    .select({
      hirerId: quest.hirerId,
      moneyHoldStartedAt: quest.moneyHoldStartedAt,
    })
    .from(quest)
    .where(eq(quest.id, questId))
    .limit(1);
  if (!row || !isMoneyHoldOpen(row)) return null;

  const [existing] = await db
    .select()
    .from(adminDisputeCase)
    .where(and(eq(adminDisputeCase.questId, questId), eq(adminDisputeCase.filerUserId, viewerId)))
    .limit(1);
  const [assignment] =
    viewerId === row.hirerId
      ? [undefined]
      : await db
          .select({ id: questAssignment.id, status: questAssignment.assignmentStatus })
          .from(questAssignment)
          .where(and(eq(questAssignment.questId, questId), eq(questAssignment.workerId, viewerId)))
          .limit(1);
  const teamMemberOnly =
    assignment !== undefined && (await isSelectedTeamMemberOnly(db, questId, viewerId));
  const endsAt = new Date(row.moneyHoldStartedAt.getTime() + disputeFilingWindowMs(false));
  const open = now.getTime() <= endsAt.getTime();
  const team = await db.transaction((transaction) => readSelectedTeam(transaction, questId));
  const [teamMembership] = team
    ? await db
        .select({ memberId: questCandidateTeamV2Member.memberId })
        .from(questCandidateTeamV2Member)
        .where(
          and(
            eq(questCandidateTeamV2Member.teamId, team.id),
            eq(questCandidateTeamV2Member.memberId, viewerId)
          )
        )
        .limit(1)
    : [undefined];
  const viewerRole: QuestDisputeViewerRole =
    viewerId === row.hirerId
      ? 'HIRER'
      : team && teamMembership
        ? team.leaderId === viewerId
          ? 'TEAM_LEADER'
          : 'TEAM_MEMBER'
        : 'WORKER';
  const caseView = (record: typeof adminDisputeCase.$inferSelect): QuestDisputeCaseView => ({
    id: record.id,
    displayId: formatDisputeDisplayId(record.publicSequence),
    status: record.status,
    createdAt: record.createdAt,
  });
  const [teamCaseRecord] =
    team && teamMembership
      ? await db
          .select()
          .from(adminDisputeCase)
          .where(and(eq(adminDisputeCase.questId, questId), eq(adminDisputeCase.teamId, team.id)))
          .limit(1)
      : [undefined];
  const split =
    team && teamMembership ? await readTeamDisputeSplit(viewerId, questId, now) : undefined;
  return {
    canFile:
      open &&
      !existing &&
      viewerRole !== 'TEAM_MEMBER' &&
      !teamMemberOnly &&
      (viewerId === row.hirerId ||
        (assignment !== undefined && assignment.status !== 'ASSIGNMENT_COMPLETED')),
    windowEndsAt: open ? endsAt : null,
    viewerRole,
    myCase: existing ? caseView(existing) : null,
    teamCase: teamCaseRecord ? caseView(teamCaseRecord) : null,
    teamSplit: split && !('outcome' in split) ? split : null,
  };
};

export type QuestMoneyHold = {
  status: 'HELD' | 'RELEASED';
  releasesAt: Date;
  /** Satang still held in the Hirer's Funding Reservation; null for a Worker viewer. */
  heldSatang: number | null;
};

/**
 * The 7-day money hold. It ends at `moneyHoldStartedAt + 7 days` and a Dispute Case does not
 * move that instant (Admin Rulebook), so `releasesAt` stays the nominal time even if the
 * lifecycle worker runs late. Null unless the Quest has a money hold.
 */
export const readQuestMoneyHold = async (
  viewerId: string,
  questId: string
): Promise<QuestMoneyHold | null> => {
  const [row] = await db
    .select({
      hirerId: quest.hirerId,
      moneyHoldStartedAt: quest.moneyHoldStartedAt,
    })
    .from(quest)
    .where(eq(quest.id, questId))
    .limit(1);
  if (!row || !isMoneyHoldOpen(row)) return null;
  const releasesAt = new Date(row.moneyHoldStartedAt.getTime() + moneyHoldDurationMs);
  const escrow = await db.transaction((transaction) =>
    readQuestEscrow(transaction, { ownerUserId: row.hirerId, questId })
  );
  const held = escrow?.status === 'ACTIVE';
  return {
    status: held ? 'HELD' : 'RELEASED',
    releasesAt,
    heldSatang: viewerId === row.hirerId ? (held ? escrow.remainingSatang : 0) : null,
  };
};
