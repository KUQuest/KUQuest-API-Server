import { db } from '@/database/client';
import { memberPenaltyRecord, type MemberPenaltyResult } from '@/database/schema/admin.schema';
import { authUser } from '@/database/schema/auth.schema';
import { review } from '@/database/schema/quest.schema';
import { walletStatusHistory, walletWallet } from '@/database/schema/wallet.schema';
import { changeWalletStatusInTransaction } from '@/modules/wallet/wallet.status.service';
import { ensureWalletInTransaction } from '@/modules/wallet/wallet.service';

import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNotNull,
  lte,
  sql as drizzleSql,
  sum,
} from 'drizzle-orm';

export type MemberPenaltyTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

type MemberPenaltyRow = typeof memberPenaltyRecord.$inferSelect;
type MemberPenaltyInput = {
  memberId: string;
  source: 'REPORT_CASE' | 'CONDUCT_REPORT';
  sourceId: string;
  actorAdminId: string;
  reasonCode: string;
  now: Date;
};

const dayMilliseconds = 24 * 60 * 60 * 1000;

const addDays = (date: Date, days: number): Date =>
  new Date(date.getTime() + days * dayMilliseconds);

const addOneCalendarMonth = (date: Date): Date => {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const result = new Date(date);
  result.setUTCFullYear(year, month, Math.min(day, lastDay));
  return result;
};

const isTemporaryBan = (result: MemberPenaltyResult): boolean =>
  result === 'PENALTY_TEMPORARY_BAN_7_DAYS' || result === 'PENALTY_TEMPORARY_BAN_1_MONTH';
const isBanResult = (result: MemberPenaltyResult): boolean =>
  isTemporaryBan(result) || result === 'PENALTY_PERMANENT_BAN';

const automaticBanFreezeReason = (penaltyRecordId: string): string =>
  `Automatic Member Ban freeze: ${penaltyRecordId}`;
const isAutomaticBanFreezeReason = (reason: string | null): boolean =>
  reason?.startsWith('Automatic Member Ban freeze: ') ?? false;

const temporaryBanExpiresAt = (record: MemberPenaltyRow): Date | null => {
  if (record.result === 'PENALTY_TEMPORARY_BAN_7_DAYS') return addDays(record.createdAt, 7);
  if (record.result === 'PENALTY_TEMPORARY_BAN_1_MONTH')
    return addOneCalendarMonth(record.createdAt);
  return null;
};

const latestDate = (dates: Date[]): Date | null =>
  dates.reduce<Date | null>(
    (latest, date) => (latest === null || date > latest ? date : latest),
    null
  );

const originalRecords = (records: MemberPenaltyRow[]): MemberPenaltyRow[] =>
  records.filter((record) => record.result !== 'PENALTY_REVERSAL');

const reversedRecordIds = (records: MemberPenaltyRow[]): Set<string> =>
  new Set(
    records.flatMap((record) =>
      record.result === 'PENALTY_REVERSAL' && record.reversalOfRecordId
        ? [record.reversalOfRecordId]
        : []
    )
  );

const activeOriginalRecords = (records: MemberPenaltyRow[]): MemberPenaltyRow[] => {
  const reversed = reversedRecordIds(records);
  return originalRecords(records).filter((record) => !reversed.has(record.id));
};

const readMemberRecords = async (
  transaction: MemberPenaltyTransaction,
  memberId: string
): Promise<MemberPenaltyRow[]> =>
  transaction
    .select()
    .from(memberPenaltyRecord)
    .where(eq(memberPenaltyRecord.memberId, memberId))
    .orderBy(asc(memberPenaltyRecord.createdAt), asc(memberPenaltyRecord.id));

const lockMemberPenaltyMutation = async (
  transaction: MemberPenaltyTransaction,
  memberId: string
): Promise<void> => {
  await transaction.execute(
    drizzleSql`select pg_advisory_xact_lock(hashtextextended(${`member-penalty:${memberId}`}, 0))`
  );
};

const lockMember = async (
  transaction: MemberPenaltyTransaction,
  memberId: string
): Promise<{ id: string; createdAt: Date }> => {
  await lockMemberPenaltyMutation(transaction, memberId);
  const [member] = await transaction
    .select({ id: authUser.id, createdAt: authUser.createdAt })
    .from(authUser)
    .where(eq(authUser.id, memberId))
    .limit(1);

  if (!member) throw new Error('Member Penalty requires an existing Member.');
  return member;
};

const nextSequenceNumber = (records: MemberPenaltyRow[], ladder: 'MISCONDUCT' | 'REVIEW') =>
  records.reduce(
    (maximum, record) =>
      record.ladder === ladder ? Math.max(maximum, record.sequenceNumber) : maximum,
    0
  ) + 1;

const banLiftTimes = (records: MemberPenaltyRow[], now: Date): Date[] => {
  const reversals = new Map(
    records.flatMap((record) =>
      record.result === 'PENALTY_REVERSAL' && record.reversalOfRecordId
        ? [[record.reversalOfRecordId, record.createdAt] as const]
        : []
    )
  );

  return originalRecords(records).flatMap((record) => {
    if (record.result === 'PENALTY_PERMANENT_BAN') {
      const reversalAt = reversals.get(record.id);
      return reversalAt ? [reversalAt] : [];
    }

    if (!isTemporaryBan(record.result)) return [];
    const expiry = temporaryBanExpiresAt(record);
    if (!expiry) return [];

    const reversalAt = reversals.get(record.id);
    if (reversalAt) return [reversalAt < expiry ? reversalAt : expiry];
    return expiry <= now ? [expiry] : [];
  });
};

const activeBanRecord = (records: MemberPenaltyRow[], now: Date): MemberPenaltyRow | undefined =>
  activeOriginalRecords(records).find((record) => {
    if (record.result === 'PENALTY_PERMANENT_BAN') return true;
    const expiry = temporaryBanExpiresAt(record);
    return expiry !== null && expiry > now;
  });

const reconcileBanWalletStatusInTransaction = async (
  transaction: MemberPenaltyTransaction,
  memberId: string,
  records: MemberPenaltyRow[],
  now: Date
): Promise<void> => {
  const activeBan = activeBanRecord(records, now);
  if (activeBan) await ensureWalletInTransaction(transaction, memberId);

  const [wallet] = await transaction
    .select()
    .from(walletWallet)
    .where(eq(walletWallet.userId, memberId))
    .for('update');
  if (!wallet) return;

  if (activeBan) {
    if (wallet.walletStatus !== 'ACTIVE') return;

    await changeWalletStatusInTransaction(transaction, {
      walletId: wallet.id,
      toStatus: 'FROZEN',
      reason: automaticBanFreezeReason(activeBan.id),
      actorSystem: true,
    });
    return;
  }

  if (wallet.walletStatus !== 'FROZEN') return;
  const [latestStatus] = await transaction
    .select({
      actorAdminId: walletStatusHistory.actorAdminId,
      actorUserId: walletStatusHistory.actorUserId,
      reason: walletStatusHistory.reason,
      toStatus: walletStatusHistory.toStatus,
    })
    .from(walletStatusHistory)
    .where(eq(walletStatusHistory.walletId, wallet.id))
    .orderBy(desc(walletStatusHistory.occurredAt), desc(walletStatusHistory.id))
    .limit(1);
  if (
    latestStatus?.toStatus !== 'FROZEN' ||
    latestStatus.actorAdminId !== null ||
    latestStatus.actorUserId !== null ||
    !isAutomaticBanFreezeReason(latestStatus.reason)
  ) {
    return;
  }

  await changeWalletStatusInTransaction(transaction, {
    walletId: wallet.id,
    toStatus: 'ACTIVE',
    reason: 'Automatic Member Ban freeze expired.',
    actorSystem: true,
  });
};

const rebuildMemberProjections = async (
  transaction: MemberPenaltyTransaction,
  memberId: string,
  now: Date
): Promise<void> => {
  const records = await readMemberRecords(transaction, memberId);
  const active = activeOriginalRecords(records);
  const redFlagExpiresAt = latestDate(
    active
      .filter((record) => record.result === 'PENALTY_RED_FLAG')
      .map((record) => addDays(record.createdAt, 7))
      .filter((expiry) => expiry > now)
  );
  const bannedUntil = latestDate(
    active
      .filter((record) => isTemporaryBan(record.result))
      .flatMap((record) => {
        const expiry = temporaryBanExpiresAt(record);
        return expiry && expiry > now ? [expiry] : [];
      })
  );

  await transaction
    .update(authUser)
    .set({ bannedUntil, redFlagExpiresAt })
    .where(eq(authUser.id, memberId));
};

const confirmedMisconductRecords = (records: MemberPenaltyRow[], memberCreatedAt: Date) =>
  originalRecords(records).filter(
    (record) =>
      record.ladder === 'MISCONDUCT' &&
      record.source !== 'REVIEW_AVERAGE' &&
      record.createdAt >= memberCreatedAt
  );

const misconductResult = (strikeCount: number): MemberPenaltyResult => {
  if (strikeCount === 1) return 'PENALTY_RED_FLAG';
  if (strikeCount === 2) return 'PENALTY_TEMPORARY_BAN_7_DAYS';
  return 'PENALTY_PERMANENT_BAN';
};

/** Record one confirmed Report Case or Conduct Report violation in its caller's transaction. */
export const recordMemberConfirmedViolationInTransaction = async (
  transaction: MemberPenaltyTransaction,
  input: MemberPenaltyInput
): Promise<MemberPenaltyRow> => {
  const member = await lockMember(transaction, input.memberId);
  const records = await readMemberRecords(transaction, input.memberId);
  const existing = originalRecords(records).find(
    (record) => record.source === input.source && record.sourceId === input.sourceId
  );
  if (existing) return existing;

  const confirmed = confirmedMisconductRecords(records, member.createdAt);
  const lastBanLift = latestDate(banLiftTimes(records, input.now));
  const violationsSinceBanLift = lastBanLift
    ? confirmed.filter((record) => record.createdAt >= lastBanLift).length
    : Number.POSITIVE_INFINITY;
  const pc13ExemptionApplies =
    lastBanLift !== null && !activeBanRecord(records, input.now) && violationsSinceBanLift < 3;
  const exemptionApplies = confirmed.length < 10 || pc13ExemptionApplies;
  const strikeCount = activeOriginalRecords(records).filter(
    (record) => record.ladder === 'MISCONDUCT' && record.result !== 'PENALTY_EXEMPT'
  ).length;
  const result = exemptionApplies ? 'PENALTY_EXEMPT' : misconductResult(strikeCount + 1);

  const [created] = await transaction
    .insert(memberPenaltyRecord)
    .values({
      memberId: input.memberId,
      ladder: 'MISCONDUCT',
      source: input.source,
      sourceId: input.sourceId,
      sequenceNumber: nextSequenceNumber(records, 'MISCONDUCT'),
      result,
      actorType: 'ADMIN',
      actorAdminId: input.actorAdminId,
      reasonCode: input.reasonCode,
      createdAt: input.now,
    })
    .returning();

  if (!created) throw new Error('Member Penalty record could not be created.');
  await rebuildMemberProjections(transaction, input.memberId, input.now);
  if (isBanResult(created.result)) {
    await reconcileBanWalletStatusInTransaction(
      transaction,
      input.memberId,
      [...records, created],
      input.now
    );
  }
  return created;
};

/** Reverse the latest un-reversed Report Case violation without deleting its source row. */
export const reverseReportCaseViolationInTransaction = async (
  transaction: MemberPenaltyTransaction,
  input: {
    memberId: string;
    reportCaseId: string;
    actorAdminId: string;
    reasonCode: string;
    now: Date;
  }
): Promise<MemberPenaltyRow | null> => {
  await lockMember(transaction, input.memberId);
  const records = await readMemberRecords(transaction, input.memberId);
  const reversed = reversedRecordIds(records);
  const reportCaseRecords = originalRecords(records).filter(
    (record) =>
      record.source === 'REPORT_CASE' &&
      record.sourceId === input.reportCaseId &&
      !reversed.has(record.id)
  );
  const original = reportCaseRecords[reportCaseRecords.length - 1];
  if (!original) return null;

  const [reversal] = await transaction
    .insert(memberPenaltyRecord)
    .values({
      memberId: input.memberId,
      ladder: original.ladder,
      source: original.source,
      sourceId: original.sourceId,
      sequenceNumber: original.sequenceNumber,
      result: 'PENALTY_REVERSAL',
      actorType: 'ADMIN',
      actorAdminId: input.actorAdminId,
      reasonCode: input.reasonCode,
      createdAt: input.now,
      reversalOfRecordId: original.id,
    })
    .returning();

  if (!reversal) throw new Error('Member Penalty reversal could not be created.');
  await rebuildMemberProjections(transaction, input.memberId, input.now);
  if (isBanResult(original.result)) {
    await reconcileBanWalletStatusInTransaction(
      transaction,
      input.memberId,
      [...records, reversal],
      input.now
    );
  }
  return reversal;
};

/** Apply the Review ladder only when a new Review causes a downward average crossing. */
export const recordReviewAveragePenaltyInTransaction = async (
  transaction: MemberPenaltyTransaction,
  input: { memberId: string; reviewId: string; rating: number; now: Date }
): Promise<MemberPenaltyRow | null> => {
  await lockMember(transaction, input.memberId);
  const [aggregate] = await transaction
    .select({ ratingTotal: sum(review.rating), reviewCount: count() })
    .from(review)
    .where(eq(review.revieweeId, input.memberId));
  const ratingTotal = Number(aggregate?.ratingTotal ?? 0);
  const reviewCount = aggregate?.reviewCount ?? 0;
  const previousCount = reviewCount - 1;
  const previousTotal = ratingTotal - input.rating;
  if (
    previousCount < 9 ||
    previousTotal < 3 * previousCount ||
    reviewCount < 10 ||
    ratingTotal >= 3 * reviewCount
  ) {
    return null;
  }

  const records = await readMemberRecords(transaction, input.memberId);
  const strikeCount = activeOriginalRecords(records).filter(
    (record) => record.ladder === 'REVIEW'
  ).length;
  const result: MemberPenaltyResult =
    strikeCount === 0
      ? 'PENALTY_TEMPORARY_BAN_7_DAYS'
      : strikeCount === 1
        ? 'PENALTY_TEMPORARY_BAN_1_MONTH'
        : 'PENALTY_PERMANENT_BAN';
  const [created] = await transaction
    .insert(memberPenaltyRecord)
    .values({
      memberId: input.memberId,
      ladder: 'REVIEW',
      source: 'REVIEW_AVERAGE',
      sourceId: input.reviewId,
      sequenceNumber: nextSequenceNumber(records, 'REVIEW'),
      result,
      actorType: 'SYSTEM',
      actorAdminId: null,
      reasonCode: 'REVIEW_AVERAGE_LOW',
      createdAt: input.now,
    })
    .returning();

  if (!created) throw new Error('Review penalty record could not be created.');
  await rebuildMemberProjections(transaction, input.memberId, input.now);
  if (isBanResult(created.result)) {
    await reconcileBanWalletStatusInTransaction(
      transaction,
      input.memberId,
      [...records, created],
      input.now
    );
  }
  return created;
};

const expiredBanBatchSize = 100;

/** Process one Member whose projected temporary Ban expiry has passed. */
export const processExpiredMemberBanWalletFreeze = async (
  memberId: string,
  now = new Date()
): Promise<boolean> =>
  db.transaction(async (transaction) => {
    await lockMemberPenaltyMutation(transaction, memberId);
    const [lockedMember] = await transaction
      .select({ bannedUntil: authUser.bannedUntil })
      .from(authUser)
      .where(eq(authUser.id, memberId))
      .for('update');
    if (!lockedMember?.bannedUntil || lockedMember.bannedUntil > now) return false;

    const records = await readMemberRecords(transaction, memberId);
    await rebuildMemberProjections(transaction, memberId, now);
    await reconcileBanWalletStatusInTransaction(transaction, memberId, records, now);
    return true;
  });

/** Clear expired Member Ban projections and lift only an automatic Wallet freeze. */
export const processExpiredMemberBanWalletFreezes = async (now = new Date()): Promise<number> => {
  let processed = 0;
  let firstError: unknown;
  let hasErrors = false;
  const expiredMembers = await db
    .select({ id: authUser.id })
    .from(authUser)
    .where(and(isNotNull(authUser.bannedUntil), lte(authUser.bannedUntil, now)))
    .orderBy(asc(authUser.bannedUntil), asc(authUser.id))
    .limit(expiredBanBatchSize);

  for (const member of expiredMembers) {
    try {
      // Serialize Member updates and continue after one Member's transaction fails.
      // eslint-disable-next-line no-await-in-loop
      const didProcess = await processExpiredMemberBanWalletFreeze(member.id, now);
      if (didProcess) processed += 1;
    } catch (error) {
      if (!hasErrors) {
        firstError = error;
        hasErrors = true;
      }
    }
  }

  if (hasErrors) throw firstError;
  return processed;
};

export type MemberPenaltyRestriction = {
  banned: boolean;
  permanentlyBanned: boolean;
  bannedUntil: Date | null;
  redFlagged: boolean;
  redFlagExpiresAt: Date | null;
};

/** Read Auth projections and the permanent-ban source record for one Member. */
export const readMemberPenaltyRestriction = async (
  memberId: string,
  now = new Date()
): Promise<MemberPenaltyRestriction> => {
  const [member] = await db
    .select({ bannedUntil: authUser.bannedUntil, redFlagExpiresAt: authUser.redFlagExpiresAt })
    .from(authUser)
    .where(eq(authUser.id, memberId))
    .limit(1);
  if (!member) {
    return {
      banned: false,
      permanentlyBanned: false,
      bannedUntil: null,
      redFlagged: false,
      redFlagExpiresAt: null,
    };
  }

  const permanentRecords = await db
    .select({ id: memberPenaltyRecord.id })
    .from(memberPenaltyRecord)
    .where(
      and(
        eq(memberPenaltyRecord.memberId, memberId),
        eq(memberPenaltyRecord.result, 'PENALTY_PERMANENT_BAN')
      )
    );
  const permanentRecordIds = permanentRecords.map((record) => record.id);
  const reversals = permanentRecordIds.length
    ? await db
        .select({ reversalOfRecordId: memberPenaltyRecord.reversalOfRecordId })
        .from(memberPenaltyRecord)
        .where(inArray(memberPenaltyRecord.reversalOfRecordId, permanentRecordIds))
    : [];
  const reversedIds = new Set(reversals.map((record) => record.reversalOfRecordId));
  const permanentlyBanned = permanentRecordIds.some((id) => !reversedIds.has(id));
  const bannedUntil = member.bannedUntil && member.bannedUntil > now ? member.bannedUntil : null;
  const redFlagExpiresAt =
    member.redFlagExpiresAt && member.redFlagExpiresAt > now ? member.redFlagExpiresAt : null;

  return {
    banned: permanentlyBanned || bannedUntil !== null,
    permanentlyBanned,
    bannedUntil,
    redFlagged: redFlagExpiresAt !== null,
    redFlagExpiresAt,
  };
};

export const isMemberRedFlagged = async (memberId: string, now = new Date()): Promise<boolean> => {
  const [member] = await db
    .select({ redFlagExpiresAt: authUser.redFlagExpiresAt })
    .from(authUser)
    .where(eq(authUser.id, memberId))
    .limit(1);
  return Boolean(member?.redFlagExpiresAt && member.redFlagExpiresAt > now);
};

export const isMemberRedFlaggedInTransaction = async (
  transaction: MemberPenaltyTransaction,
  memberId: string,
  now: Date
): Promise<boolean> => {
  await lockMemberPenaltyMutation(transaction, memberId);
  const [member] = await transaction
    .select({ redFlagExpiresAt: authUser.redFlagExpiresAt })
    .from(authUser)
    .where(eq(authUser.id, memberId))
    .limit(1);
  return Boolean(member?.redFlagExpiresAt && member.redFlagExpiresAt > now);
};

export const hasRedFlaggedMemberInTransaction = async (
  transaction: MemberPenaltyTransaction,
  memberIds: string[],
  now: Date
): Promise<boolean> => {
  const orderedMemberIds = [...new Set(memberIds)].sort();
  for (const memberId of orderedMemberIds) {
    if (await isMemberRedFlaggedInTransaction(transaction, memberId, now)) return true;
  }
  return false;
};

export const isRedFlagActive = (expiresAt: Date | null, now = new Date()): boolean =>
  expiresAt !== null && expiresAt > now;

export const isMemberBanned = async (memberId: string, now = new Date()): Promise<boolean> =>
  (await readMemberPenaltyRestriction(memberId, now)).banned;
