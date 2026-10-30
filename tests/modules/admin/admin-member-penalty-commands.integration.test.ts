import { app } from '@/app';
import { db } from '@/database/client';
import {
  adminAction,
  adminConductReport,
  adminReportCase,
  conductReportReason,
  conductReportStatus,
  memberPenaltyRecord,
  type MemberPenaltyResult,
  reportCaseStatus,
} from '@/database/schema/admin.schema';
import { authAdmin, authUser } from '@/database/schema/auth.schema';
import { quest, questAssignment, review } from '@/database/schema/quest.schema';
import { tag } from '@/database/schema/tag.schema';
import { walletStatusHistory, walletWallet } from '@/database/schema/wallet.schema';
import { chatConversation, chatMembership, chatMessage } from '@/database/schema/work-chat.schema';
import {
  readMemberPenaltyRestriction,
  recordMemberConfirmedViolationInTransaction,
  recordReviewAveragePenaltyInTransaction,
} from '@/modules/admin/member-penalty';
import {
  memberPenaltyAddReasonCodes,
  memberPenaltyRemoveReasonCodes,
} from '@/modules/admin/member-penalty/member-penalty.policy';
import { createAdminAuth } from '@/modules/auth/admin-auth.config';
import { authGuard, createStudentAuth, memberBanGuard } from '@/modules/auth';
import { ensureWalletInTransaction } from '@/modules/wallet';

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { asc, count, desc, eq, inArray } from 'drizzle-orm';
import { Elysia } from 'elysia';

const permittedResults = [
  'PENALTY_RED_FLAG',
  'PENALTY_TEMPORARY_BAN_7_DAYS',
  'PENALTY_PERMANENT_BAN',
] as const;
const dayMilliseconds = 24 * 60 * 60 * 1000;

const studentAuth = createStudentAuth({
  emailAndPasswordEnabled: true,
  allowEmailSignUp: true,
  autoSignIn: false,
  provisionWalletOnCreate: false,
});
const memberApp = new Elysia({ name: 'member-penalty-commands-member-app' })
  .use(authGuard)
  .use(memberBanGuard)
  .get('/member-only', ({ session }) => ({ memberId: session.user.id }));

type CommandBody = {
  success: true;
  data: {
    command: {
      kind: 'ADD' | 'REMOVE';
      outcome: 'ADDED' | 'EXEMPTED' | 'REMOVED';
      recordId: string;
      commandRecordId: string;
      result: MemberPenaltyResult;
      versionToken: number;
    };
  };
};
type ErrorBody = { success: false; error: { code: string; message: string } };
type HistoryLink = { sequenceNumber: number; result: MemberPenaltyResult } | null;
type HistoryItem = {
  recordId: string;
  ladder: 'MISCONDUCT' | 'REVIEW';
  source: 'REPORT_CASE' | 'CONDUCT_REPORT' | 'REVIEW_AVERAGE' | 'ADMIN';
  sourceDisplayId: string | null;
  sequenceNumber: number;
  result: MemberPenaltyResult;
  actor: { type: 'ADMIN' | 'SYSTEM'; displayName: string };
  reasonCode: string;
  adminNote: string | null;
  isEffective: boolean;
  reversal: (NonNullable<HistoryLink> & { relation: 'REVERSAL_OF' | 'REVERSED_BY' }) | null;
  recalculatedFrom: HistoryLink;
  replacedBy: HistoryLink;
};
type HistoryBody = {
  success: true;
  data: { versionToken: number; items: HistoryItem[]; totalCount: number };
};

let adminId = '';
let adminCookie = '';
const disabledAdminIds: string[] = [];

const cookieHeader = (response: Response): string =>
  (response.headers.getSetCookie?.() ?? []).map((cookie) => cookie.split(';', 1)[0]).join('; ');

const createAdminSession = async (): Promise<{ id: string; cookie: string }> => {
  const email = `member-penalty-commands-${randomUUID()}@example.com`;
  const password = 'MemberPenaltyAdmin1!';
  const adminAuth = createAdminAuth({
    allowSignUp: true,
    autoSignIn: false,
    markEmailVerified: true,
  });
  const signUp = await adminAuth.api.signUpEmail({
    body: { email, password, name: 'Penalty Admin', firstName: 'Penalty', lastName: 'Admin' },
  });
  const signIn = await app.handle(
    new Request('http://localhost/api/admin/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })
  );
  if (signIn.status !== 200) throw new Error('Penalty Admin session was not created.');
  disabledAdminIds.push(signUp.user.id);
  return { id: signUp.user.id, cookie: cookieHeader(signIn) };
};

const authRequest = (path: string, body: unknown) =>
  studentAuth.handler(
    new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  );

const signUpMember = async () => {
  const email = `member-penalty-commands-${randomUUID()}@ku.th`;
  const password = 'MemberPenaltyPass1!';
  const signUp = await authRequest('/api/auth/sign-up/email', {
    email,
    password,
    name: 'Penalty Member',
    firstName: 'Penalty',
    lastName: 'Member',
  });
  if (signUp.status !== 200) throw new Error('Penalty Member was not created.');
  const signUpBody = (await signUp.json()) as { user: { id: string } };
  const signIn = () => authRequest('/api/auth/sign-in/email', { email, password });
  const firstSignIn = await signIn();
  if (firstSignIn.status !== 200) throw new Error('Penalty Member session was not created.');
  return { id: signUpBody.user.id, cookie: cookieHeader(firstSignIn), signIn };
};

const memberRequest = (cookie: string) =>
  memberApp.handle(new Request('http://localhost/member-only', { headers: { cookie } }));

const createMember = async (): Promise<string> => {
  const id = randomUUID();
  await db.insert(authUser).values({
    id,
    email: `${id}@ku.th`,
    firstName: 'Penalty',
    lastName: 'Member',
    createdAt: new Date('2020-01-01T00:00:00.000Z'),
  });
  return id;
};

const postCommand = (
  memberId: string,
  action: 'add' | 'remove',
  body: unknown,
  options: { key?: string | null; cookie?: string } = {}
) => {
  const key = options.key === undefined ? randomUUID() : options.key;
  const cookie = options.cookie ?? adminCookie;
  return app.handle(
    new Request(`http://localhost/api/v1/admin/members/${memberId}/penalty-actions/${action}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cookie ? { cookie } : {}),
        ...(key === null ? {} : { 'idempotency-key': key }),
      },
      body: JSON.stringify(body),
    })
  );
};

const readHistory = async (memberId: string): Promise<HistoryBody['data']> => {
  const response = await app.handle(
    new Request(`http://localhost/api/v1/admin/members/${memberId}/penalty-history?limit=50`, {
      headers: { cookie: adminCookie },
    })
  );
  expect(response.status).toBe(200);
  return ((await response.json()) as HistoryBody).data;
};

const currentToken = async (memberId: string): Promise<number> =>
  (await readHistory(memberId)).versionToken;

const expectCommand = async (response: Response) => {
  expect(response.status).toBe(200);
  return ((await response.json()) as CommandBody).data.command;
};

const expectError = async (response: Response, status: number, code: string) => {
  expect(response.status).toBe(status);
  expect(((await response.json()) as ErrorBody).error.code).toBe(code);
};

const addPenalty = async (
  memberId: string,
  result: (typeof permittedResults)[number] = 'PENALTY_RED_FLAG',
  options: { key?: string; adminNote?: string; cookie?: string } = {}
) =>
  expectCommand(
    await postCommand(
      memberId,
      'add',
      {
        expectedVersionToken: await currentToken(memberId),
        result,
        reasonCode: 'MEMBER_PENALTY_VIOLATION_CONFIRMED',
        ...(options.adminNote === undefined ? {} : { adminNote: options.adminNote }),
      },
      { key: options.key, cookie: options.cookie }
    )
  );

const removePenalty = async (
  memberId: string,
  recordId: string,
  options: { key?: string; adminNote?: string } = {}
) =>
  expectCommand(
    await postCommand(
      memberId,
      'remove',
      {
        expectedVersionToken: await currentToken(memberId),
        recordId,
        reasonCode: 'MEMBER_PENALTY_ADMIN_ERROR',
        ...(options.adminNote === undefined ? {} : { adminNote: options.adminNote }),
      },
      { key: options.key }
    )
  );

const recordStrike = (
  memberId: string,
  source: 'REPORT_CASE' | 'CONDUCT_REPORT' = 'CONDUCT_REPORT',
  options: { at?: Date; sourceId?: string } = {}
) =>
  db.transaction((transaction) =>
    recordMemberConfirmedViolationInTransaction(transaction, {
      memberId,
      source,
      sourceId: options.sourceId ?? randomUUID(),
      actorAdminId: adminId,
      reasonCode: source === 'CONDUCT_REPORT' ? conductReportReason.abandoned : 'POLICY_REVIEW',
      now: options.at ?? new Date(),
    })
  );

const recordStrikes = async (memberId: string, total: number) => {
  const records = [];
  for (let index = 0; index < total; index += 1) {
    // Each strike reads the ladder that the earlier strike changed.
    // eslint-disable-next-line no-await-in-loop
    records.push(await recordStrike(memberId));
  }
  return records;
};

const penaltyRows = (memberId: string) =>
  db
    .select()
    .from(memberPenaltyRecord)
    .where(eq(memberPenaltyRecord.memberId, memberId))
    .orderBy(asc(memberPenaltyRecord.createdAt), asc(memberPenaltyRecord.id));

const authProjection = async (memberId: string) => {
  const [row] = await db
    .select({ bannedUntil: authUser.bannedUntil, redFlagExpiresAt: authUser.redFlagExpiresAt })
    .from(authUser)
    .where(eq(authUser.id, memberId));
  return row!;
};

const ensureWallet = (memberId: string) =>
  db.transaction((transaction) => ensureWalletInTransaction(transaction, memberId));

const walletOf = async (memberId: string) => {
  const [wallet] = await db.select().from(walletWallet).where(eq(walletWallet.userId, memberId));
  return wallet;
};

const walletHistory = async (walletId: string) =>
  db
    .select()
    .from(walletStatusHistory)
    .where(eq(walletStatusHistory.walletId, walletId))
    .orderBy(desc(walletStatusHistory.occurredAt), desc(walletStatusHistory.id));

const changeWalletStatus = async (
  walletId: string,
  toStatus: 'ACTIVE' | 'FROZEN' | 'SUSPENDED'
) => {
  const response = await app.handle(
    new Request(`http://localhost/api/v1/admin/wallets/${walletId}/status`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: adminCookie,
        'idempotency-key': randomUUID(),
      },
      body: JSON.stringify({ toStatus, reason: 'Discretionary Wallet review.' }),
    })
  );
  expect(response.status).toBe(200);
};

const expectAboutSevenDaysFromNow = (date: Date | null) => {
  expect(date).not.toBeNull();
  const remaining = date!.getTime() - Date.now();
  expect(remaining).toBeGreaterThan(7 * dayMilliseconds - 60_000);
  expect(remaining).toBeLessThanOrEqual(7 * dayMilliseconds);
};

const seedSourceQuest = async (memberId: string) => {
  const filerId = await createMember();
  const tagId = randomUUID();
  const questId = randomUUID();
  const assignmentId = randomUUID();
  const conversationId = randomUUID();
  const membershipId = randomUUID();
  const createdAt = new Date('2025-01-01T00:00:00.000Z');
  await db.insert(tag).values({ id: tagId, name: `Penalty command ${tagId}` });
  await db.insert(quest).values({
    id: questId,
    hirerId: filerId,
    title: 'Penalty command source Quest',
    condition: 'Complete the source Quest',
    mode: 'NO_CANDIDATE',
    participation: 'SOLO',
    questStatus: 'QUEST_ASSIGNED',
    rewardSatang: 1_000,
    tagId,
    startTime: createdAt,
    createdAt,
    updatedAt: createdAt,
  });
  await db.insert(questAssignment).values({
    id: assignmentId,
    questId,
    workerId: memberId,
    assignmentStatus: 'ASSIGNMENT_ACTIVE',
    createdAt,
  });
  await db.insert(chatConversation).values({
    id: conversationId,
    questId,
    type: 'CONVERSATION_WORK',
    questTitle: 'Penalty command source Quest',
    questStatus: 'QUEST_ASSIGNED',
    nextSequence: 3,
    createdAt,
    updatedAt: createdAt,
  });
  await db.insert(chatMembership).values({
    id: membershipId,
    conversationId,
    assignmentId,
    memberId,
    role: 'WORKER',
    joinedAt: createdAt,
    createdAt,
  });
  return { filerId, questId, assignmentId, conversationId, membershipId, createdAt };
};

const seedHiddenReportCase = async (
  source: Awaited<ReturnType<typeof seedSourceQuest>>,
  sequence: number
) => {
  const messageId = randomUUID();
  const reportCaseId = randomUUID();
  await db.insert(chatMessage).values({
    id: messageId,
    conversationId: source.conversationId,
    sequence,
    kind: 'USER',
    senderMembershipId: source.membershipId,
    clientMessageId: `penalty-command-${messageId}`,
    contentText: 'Penalty command source Message',
    createdAt: source.createdAt,
  });
  await db.insert(adminReportCase).values({
    id: reportCaseId,
    messageId,
    status: reportCaseStatus.hidden,
    createdAt: source.createdAt,
    updatedAt: source.createdAt,
  });
  return reportCaseId;
};

beforeAll(async () => {
  const admin = await createAdminSession();
  adminId = admin.id;
  adminCookie = admin.cookie;
});

// The immutable Penalty History restricts removal of its Member and Admin rows.
afterAll(async () => {
  await db
    .update(authAdmin)
    .set({ disabledAt: new Date() })
    .where(inArray(authAdmin.id, disabledAdminIds));
});

describe('Direct Member Penalty command access', () => {
  it('requires an enabled Admin Session on Add and Remove', async () => {
    const memberId = await createMember();
    const member = await signUpMember();
    const disabledAdmin = await createAdminSession();
    const record = await recordStrike(memberId);
    const addBody = {
      expectedVersionToken: 1,
      result: 'PENALTY_PERMANENT_BAN',
      reasonCode: 'MEMBER_PENALTY_SAFETY_RISK_CONFIRMED',
    };
    const removeBody = {
      expectedVersionToken: 1,
      recordId: record.id,
      reasonCode: 'MEMBER_PENALTY_ADMIN_ERROR',
    };
    await db
      .update(authAdmin)
      .set({ disabledAt: new Date() })
      .where(eq(authAdmin.id, disabledAdmin.id));

    for (const [action, body] of [
      ['add', addBody],
      ['remove', removeBody],
    ] as const) {
      // eslint-disable-next-line no-await-in-loop
      const anonymous = await postCommand(memberId, action, body, { cookie: '' });
      expect(anonymous.status).toBe(401);
      // eslint-disable-next-line no-await-in-loop
      const memberResponse = await postCommand(memberId, action, body, { cookie: member.cookie });
      expect([401, 403]).toContain(memberResponse.status);
      // eslint-disable-next-line no-await-in-loop
      const disabled = await postCommand(memberId, action, body, { cookie: disabledAdmin.cookie });
      expect(disabled.status).toBe(403);
    }

    expect(await penaltyRows(memberId)).toHaveLength(1);
    expect(await readMemberPenaltyRestriction(memberId)).toMatchObject({ banned: false });
  });
});

describe('Add a direct Member Penalty', () => {
  for (const result of permittedResults) {
    for (const reasonCode of memberPenaltyAddReasonCodes) {
      it(`saves ${result} with ${reasonCode}`, async () => {
        const memberId = await createMember();

        const command = await expectCommand(
          await postCommand(memberId, 'add', { expectedVersionToken: 0, result, reasonCode })
        );

        expect(command).toMatchObject({
          kind: 'ADD',
          outcome: 'ADDED',
          result,
          versionToken: 1,
        });
        expect(command.commandRecordId).toBe(command.recordId);
        const history = await readHistory(memberId);
        expect(history.versionToken).toBe(1);
        expect(history.items).toHaveLength(1);
        expect(history.items[0]).toMatchObject({
          recordId: command.recordId,
          ladder: 'MISCONDUCT',
          source: 'ADMIN',
          sourceDisplayId: null,
          sequenceNumber: 1,
          result,
          reasonCode,
          adminNote: null,
          isEffective: true,
          actor: { type: 'ADMIN' },
        });
      });
    }
  }

  it('projects the restriction of each selected result', async () => {
    const redFlagged = await createMember();
    await addPenalty(redFlagged, 'PENALTY_RED_FLAG');
    const redFlagProjection = await authProjection(redFlagged);
    expectAboutSevenDaysFromNow(redFlagProjection.redFlagExpiresAt);
    expect(redFlagProjection.bannedUntil).toBeNull();
    expect(await readMemberPenaltyRestriction(redFlagged)).toMatchObject({
      banned: false,
      redFlagged: true,
    });

    const temporarilyBanned = await createMember();
    await addPenalty(temporarilyBanned, 'PENALTY_TEMPORARY_BAN_7_DAYS');
    const temporaryProjection = await authProjection(temporarilyBanned);
    expectAboutSevenDaysFromNow(temporaryProjection.bannedUntil);
    expect(temporaryProjection.redFlagExpiresAt).toBeNull();
    expect(await readMemberPenaltyRestriction(temporarilyBanned)).toMatchObject({
      banned: true,
      permanentlyBanned: false,
    });

    const permanentlyBanned = await createMember();
    await addPenalty(permanentlyBanned, 'PENALTY_PERMANENT_BAN');
    expect(await authProjection(permanentlyBanned)).toEqual({
      bannedUntil: null,
      redFlagExpiresAt: null,
    });
    expect(await readMemberPenaltyRestriction(permanentlyBanned)).toMatchObject({
      banned: true,
      permanentlyBanned: true,
    });
  });

  it('rejects a new Add without a result and records nothing', async () => {
    const memberId = await createMember();

    await expectError(
      await postCommand(memberId, 'add', {
        expectedVersionToken: 0,
        reasonCode: 'MEMBER_PENALTY_VIOLATION_CONFIRMED',
      }),
      400,
      'PENALTY_RESULT_REQUIRED'
    );

    expect(await penaltyRows(memberId)).toHaveLength(0);
    expect(await currentToken(memberId)).toBe(0);
  });

  it('accepts a request without a result only as a replay of an accepted command', async () => {
    const memberId = await createMember();
    const key = randomUUID();
    const reasonCode = 'MEMBER_PENALTY_VIOLATION_CONFIRMED';
    const recordId = randomUUID();
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(
        JSON.stringify({
          adminId,
          kind: 'ADD',
          memberId,
          expectedVersionToken: 0,
          recordId: null,
          result: null,
          reasonCode,
          adminNote: null,
        })
      )
    );
    // A command from before the required result rule has no selected result in its hash.
    await db.insert(memberPenaltyRecord).values({
      id: recordId,
      memberId,
      ladder: 'MISCONDUCT',
      source: 'ADMIN',
      sourceId: recordId,
      sequenceNumber: 1,
      result: 'PENALTY_EXEMPT',
      actorType: 'ADMIN',
      actorAdminId: adminId,
      reasonCode,
      commandKind: 'ADD',
      commandRequestKey: key,
      commandRequestHash: Buffer.from(digest).toString('hex'),
      commandExpectedVersionToken: 0,
      commandResultVersionToken: 1,
    });

    const replay = await expectCommand(
      await postCommand(memberId, 'add', { expectedVersionToken: 0, reasonCode }, { key })
    );

    expect(replay).toEqual({
      kind: 'ADD',
      outcome: 'EXEMPTED',
      recordId,
      commandRecordId: recordId,
      result: 'PENALTY_EXEMPT',
      versionToken: 1,
    });
    expect(await penaltyRows(memberId)).toHaveLength(1);
    await expectError(
      await postCommand(memberId, 'add', { expectedVersionToken: 1, reasonCode }),
      400,
      'PENALTY_RESULT_REQUIRED'
    );
  });

  it.each([
    ['the Review ladder 1-month result', { result: 'PENALTY_TEMPORARY_BAN_1_MONTH' }],
    ['an exempt result', { result: 'PENALTY_EXEMPT' }],
    ['a reversal result', { result: 'PENALTY_REVERSAL' }],
    ['a Remove reason code', { reasonCode: 'MEMBER_PENALTY_ADMIN_ERROR' }],
    ['an unknown reason code', { reasonCode: 'MEMBER_PENALTY_UNKNOWN' }],
    ['a negative version token', { expectedVersionToken: -1 }],
  ])('rejects %s', async (_label, override) => {
    const memberId = await createMember();

    const response = await postCommand(memberId, 'add', {
      expectedVersionToken: 0,
      result: 'PENALTY_RED_FLAG',
      reasonCode: 'MEMBER_PENALTY_VIOLATION_CONFIRMED',
      ...override,
    });

    expect(response.status).toBe(400);
    expect(await penaltyRows(memberId)).toHaveLength(0);
  });

  it('requires a reason code', async () => {
    const memberId = await createMember();

    const response = await postCommand(memberId, 'add', {
      expectedVersionToken: 0,
      result: 'PENALTY_RED_FLAG',
    });

    expect(response.status).toBe(400);
    expect(await penaltyRows(memberId)).toHaveLength(0);
  });

  it('returns MEMBER_NOT_FOUND for an unknown Member', async () => {
    await expectError(
      await postCommand(randomUUID(), 'add', {
        expectedVersionToken: 0,
        result: 'PENALTY_RED_FLAG',
        reasonCode: 'MEMBER_PENALTY_VIOLATION_CONFIRMED',
      }),
      404,
      'MEMBER_NOT_FOUND'
    );
  });
});

describe('Admin note limit', () => {
  const noteAtLimit = 'น'.repeat(200);
  const noteOverLimit = 'น'.repeat(201);

  it('shows a 200-character note in Penalty History on Add and Remove', async () => {
    const memberId = await createMember();

    const added = await addPenalty(memberId, 'PENALTY_RED_FLAG', { adminNote: noteAtLimit });
    const removed = await removePenalty(memberId, added.recordId, { adminNote: noteAtLimit });

    const { items } = await readHistory(memberId);
    const note = (recordId: string) => items.find((item) => item.recordId === recordId)?.adminNote;
    expect(note(added.recordId)).toBe(noteAtLimit);
    expect(note(removed.commandRecordId)).toBe(noteAtLimit);
  });

  it('rejects a 201-character note on Add and Remove', async () => {
    const memberId = await createMember();
    const added = await addPenalty(memberId);

    expect(
      (
        await postCommand(memberId, 'add', {
          expectedVersionToken: 1,
          result: 'PENALTY_RED_FLAG',
          reasonCode: 'MEMBER_PENALTY_VIOLATION_CONFIRMED',
          adminNote: noteOverLimit,
        })
      ).status
    ).toBe(400);
    expect(
      (
        await postCommand(memberId, 'remove', {
          expectedVersionToken: 1,
          recordId: added.recordId,
          reasonCode: 'MEMBER_PENALTY_ADMIN_ERROR',
          adminNote: noteOverLimit,
        })
      ).status
    ).toBe(400);
    expect(await penaltyRows(memberId)).toHaveLength(1);
  });

  it('rejects a note that holds only spaces and trims an accepted note', async () => {
    const memberId = await createMember();

    await expectError(
      await postCommand(memberId, 'add', {
        expectedVersionToken: 0,
        result: 'PENALTY_RED_FLAG',
        reasonCode: 'MEMBER_PENALTY_VIOLATION_CONFIRMED',
        adminNote: '   ',
      }),
      400,
      'INVALID_ADMIN_NOTE'
    );
    expect(await penaltyRows(memberId)).toHaveLength(0);

    const added = await addPenalty(memberId, 'PENALTY_RED_FLAG', { adminNote: '  Checked.  ' });
    const [row] = await penaltyRows(memberId);
    expect(row).toMatchObject({ id: added.recordId, adminNote: 'Checked.' });
  });
});

describe('Remove an effective Member Penalty', () => {
  for (const reasonCode of memberPenaltyRemoveReasonCodes) {
    it(`appends a linked reversal with ${reasonCode}`, async () => {
      const memberId = await createMember();
      const added = await addPenalty(memberId);

      const command = await expectCommand(
        await postCommand(memberId, 'remove', {
          expectedVersionToken: 1,
          recordId: added.recordId,
          reasonCode,
        })
      );

      expect(command).toMatchObject({
        kind: 'REMOVE',
        outcome: 'REMOVED',
        recordId: added.recordId,
        result: 'PENALTY_REVERSAL',
        versionToken: 2,
      });
      const rows = await penaltyRows(memberId);
      expect(rows).toHaveLength(2);
      expect(rows.find((row) => row.id === added.recordId)?.result).toBe('PENALTY_RED_FLAG');
      expect(rows.find((row) => row.id === command.commandRecordId)).toMatchObject({
        result: 'PENALTY_REVERSAL',
        reversalOfRecordId: added.recordId,
        reasonCode,
        source: 'ADMIN',
        actorAdminId: adminId,
      });
      const { items } = await readHistory(memberId);
      expect(items.find((item) => item.recordId === added.recordId)).toMatchObject({
        isEffective: false,
        reversal: { relation: 'REVERSED_BY', result: 'PENALTY_REVERSAL' },
      });
      expect(
        items.find((item) => item.recordId === command.commandRecordId)?.reversal
      ).toMatchObject({ relation: 'REVERSAL_OF', result: 'PENALTY_RED_FLAG' });
    });
  }

  it('removes a Conduct Report strike and keeps the Conduct Report decision', async () => {
    const memberId = await createMember();
    const source = await seedSourceQuest(memberId);
    const conductReportId = randomUUID();
    await db.insert(adminConductReport).values({
      id: conductReportId,
      questId: source.questId,
      filerUserId: source.filerId,
      reportedMemberId: memberId,
      assignmentId: source.assignmentId,
      reason: conductReportReason.abandoned,
      status: conductReportStatus.upheld,
      decisionReason: conductReportReason.abandoned,
      resolvedByAdminId: adminId,
      resolvedAt: source.createdAt,
      createdAt: source.createdAt,
      updatedAt: source.createdAt,
    });
    const strike = await recordStrike(memberId, 'CONDUCT_REPORT', { sourceId: conductReportId });
    expect(strike.result).toBe('PENALTY_RED_FLAG');
    const [before] = await db
      .select()
      .from(adminConductReport)
      .where(eq(adminConductReport.id, conductReportId));

    const command = await removePenalty(memberId, strike.id);

    expect(command.recordId).toBe(strike.id);
    const [after] = await db
      .select()
      .from(adminConductReport)
      .where(eq(adminConductReport.id, conductReportId));
    expect(after).toEqual(before!);
    expect(after?.status).toBe(conductReportStatus.upheld);
    expect((await authProjection(memberId)).redFlagExpiresAt).toBeNull();
  });

  it('removes a Report Case strike and keeps the Report Case decision', async () => {
    const memberId = await createMember();
    const source = await seedSourceQuest(memberId);
    const exemptCaseId = await seedHiddenReportCase(source, 1);
    const strikeCaseId = await seedHiddenReportCase(source, 2);
    const exempt = await recordStrike(memberId, 'REPORT_CASE', { sourceId: exemptCaseId });
    const strike = await recordStrike(memberId, 'REPORT_CASE', { sourceId: strikeCaseId });
    expect(exempt.result).toBe('PENALTY_EXEMPT');
    expect(strike.result).toBe('PENALTY_RED_FLAG');
    const [before] = await db
      .select()
      .from(adminReportCase)
      .where(eq(adminReportCase.id, strikeCaseId));

    await removePenalty(memberId, strike.id);

    const [after] = await db
      .select()
      .from(adminReportCase)
      .where(eq(adminReportCase.id, strikeCaseId));
    expect(after).toEqual(before!);
    expect(after?.status).toBe(reportCaseStatus.hidden);
    expect((await authProjection(memberId)).redFlagExpiresAt).toBeNull();

    const nextCase = await recordStrike(memberId, 'REPORT_CASE');
    expect(nextCase.result).toBe('PENALTY_RED_FLAG');
  });

  it('removes a Review ladder penalty and keeps the Review', async () => {
    const memberId = await createMember();
    const reviewerIds = await Promise.all(Array.from({ length: 10 }, () => createMember()));
    const questId = randomUUID();
    const crossingReviewId = randomUUID();
    const now = new Date();
    await db.insert(quest).values({
      id: questId,
      hirerId: reviewerIds[0]!,
      apiVersion: 'v2',
      title: 'Penalty command Review source',
      condition: 'Review ladder source',
      mode: 'CANDIDATE',
      participation: 'SOLO',
      v2Mode: 'CANDIDATE',
      v2Participation: 'SINGLE',
      questStatus: 'QUEST_DRAFT',
      headcount: 1,
      startTime: new Date(now.getTime() + dayMilliseconds),
      rewardSatang: null,
      createdAt: now,
    });
    await db.insert(review).values(
      reviewerIds.map((reviewerId, index) => ({
        id: index === 9 ? crossingReviewId : randomUUID(),
        questId,
        reviewerId,
        revieweeId: memberId,
        rating: index === 9 ? 1 : 3,
        createdAt: now,
        updatedAt: now,
      }))
    );
    const penalty = await db.transaction((transaction) =>
      recordReviewAveragePenaltyInTransaction(transaction, {
        memberId,
        reviewId: crossingReviewId,
        rating: 1,
        now,
      })
    );
    expect(penalty?.result).toBe('PENALTY_TEMPORARY_BAN_7_DAYS');
    expect((await walletOf(memberId))?.walletStatus).toBe('FROZEN');

    await removePenalty(memberId, penalty!.id);

    const [crossingReview] = await db.select().from(review).where(eq(review.id, crossingReviewId));
    expect(crossingReview?.rating).toBe(1);
    expect(await readMemberPenaltyRestriction(memberId)).toMatchObject({ banned: false });
    expect((await walletOf(memberId))?.walletStatus).toBe('ACTIVE');
    expect(
      (await penaltyRows(memberId)).find((row) => row.reversalOfRecordId === penalty!.id)
    ).toMatchObject({ ladder: 'REVIEW', source: 'REVIEW_AVERAGE', sourceId: crossingReviewId });
  });

  it('removes a record after its timed restriction expired', async () => {
    const memberId = await createMember();
    const expired = await recordStrike(memberId, 'CONDUCT_REPORT', {
      at: new Date(Date.now() - 30 * dayMilliseconds),
    });
    const { items } = await readHistory(memberId);
    expect(items[0]).toMatchObject({ recordId: expired.id, isEffective: true });

    const command = await removePenalty(memberId, expired.id);

    expect(command).toMatchObject({ outcome: 'REMOVED', recordId: expired.id });
  });

  it('does not create a separate AdminAction record', async () => {
    const memberId = await createMember();
    const admin = await createAdminSession();
    const added = await addPenalty(memberId, 'PENALTY_PERMANENT_BAN', { cookie: admin.cookie });
    await expectCommand(
      await postCommand(
        memberId,
        'remove',
        {
          expectedVersionToken: 1,
          recordId: added.recordId,
          reasonCode: 'MEMBER_PENALTY_ADMIN_ERROR',
        },
        { cookie: admin.cookie }
      )
    );

    const [row] = await db
      .select({ total: count() })
      .from(adminAction)
      .where(eq(adminAction.adminId, admin.id));
    expect(row?.total).toBe(0);
    expect(await penaltyRows(memberId)).toHaveLength(2);
  });

  it('returns PENALTY_RECORD_NOT_FOUND for an unknown, reversal, or other-Member record', async () => {
    const memberId = await createMember();
    const otherMemberId = await createMember();
    const otherRecord = await addPenalty(otherMemberId);
    const added = await addPenalty(memberId);
    const removed = await removePenalty(memberId, added.recordId);

    for (const recordId of [randomUUID(), removed.commandRecordId, otherRecord.recordId]) {
      // eslint-disable-next-line no-await-in-loop
      const response = await postCommand(memberId, 'remove', {
        expectedVersionToken: 2,
        recordId,
        reasonCode: 'MEMBER_PENALTY_ADMIN_ERROR',
      });
      // eslint-disable-next-line no-await-in-loop
      await expectError(response, 404, 'PENALTY_RECORD_NOT_FOUND');
    }

    expect(await penaltyRows(memberId)).toHaveLength(2);
    expect(await penaltyRows(otherMemberId)).toHaveLength(1);
  });

  it('returns PENALTY_RECORD_NOT_EFFECTIVE for an exempt or reversed record', async () => {
    const memberId = await createMember();
    const exempt = await recordStrike(memberId, 'REPORT_CASE');
    expect(exempt.result).toBe('PENALTY_EXEMPT');
    const added = await addPenalty(memberId);
    await removePenalty(memberId, added.recordId);

    for (const recordId of [exempt.id, added.recordId]) {
      // eslint-disable-next-line no-await-in-loop
      const response = await postCommand(memberId, 'remove', {
        expectedVersionToken: 3,
        recordId,
        reasonCode: 'MEMBER_PENALTY_ADMIN_ERROR',
      });
      // eslint-disable-next-line no-await-in-loop
      await expectError(response, 409, 'PENALTY_RECORD_NOT_EFFECTIVE');
    }

    expect(await penaltyRows(memberId)).toHaveLength(3);
  });

  it('rejects an invalid record ID and an Add reason code', async () => {
    const memberId = await createMember();
    const added = await addPenalty(memberId);

    expect(
      (
        await postCommand(memberId, 'remove', {
          expectedVersionToken: 1,
          recordId: 'not-a-uuid',
          reasonCode: 'MEMBER_PENALTY_ADMIN_ERROR',
        })
      ).status
    ).toBe(400);
    expect(
      (
        await postCommand(memberId, 'remove', {
          expectedVersionToken: 1,
          recordId: added.recordId,
          reasonCode: 'MEMBER_PENALTY_VIOLATION_CONFIRMED',
        })
      ).status
    ).toBe(400);
    expect(await penaltyRows(memberId)).toHaveLength(1);
  });
});

describe('Penalty History version token', () => {
  it('rejects a stale token on Add and Remove', async () => {
    const memberId = await createMember();
    const added = await addPenalty(memberId);

    await expectError(
      await postCommand(memberId, 'add', {
        expectedVersionToken: 0,
        result: 'PENALTY_PERMANENT_BAN',
        reasonCode: 'MEMBER_PENALTY_VIOLATION_CONFIRMED',
      }),
      409,
      'PENALTY_HISTORY_STALE'
    );
    await expectError(
      await postCommand(memberId, 'remove', {
        expectedVersionToken: 5,
        recordId: added.recordId,
        reasonCode: 'MEMBER_PENALTY_ADMIN_ERROR',
      }),
      409,
      'PENALTY_HISTORY_STALE'
    );

    expect(await penaltyRows(memberId)).toHaveLength(1);
    expect(await readMemberPenaltyRestriction(memberId)).toMatchObject({ banned: false });
  });

  it('accepts one of two concurrent commands that read the same token', async () => {
    const memberId = await createMember();
    const body = {
      expectedVersionToken: 0,
      result: 'PENALTY_TEMPORARY_BAN_7_DAYS',
      reasonCode: 'MEMBER_PENALTY_VIOLATION_CONFIRMED',
    };

    const responses = await Promise.all([
      postCommand(memberId, 'add', body),
      postCommand(memberId, 'add', body),
    ]);

    expect(responses.map(({ status }) => status).sort()).toEqual([200, 409]);
    const rejected = responses.find(({ status }) => status === 409)!;
    expect(((await rejected.json()) as ErrorBody).error.code).toBe('PENALTY_HISTORY_STALE');
    expect(await penaltyRows(memberId)).toHaveLength(1);
  });
});

describe('Member Penalty command idempotency', () => {
  it('requires a valid Idempotency-Key', async () => {
    const memberId = await createMember();
    const body = {
      expectedVersionToken: 0,
      result: 'PENALTY_RED_FLAG',
      reasonCode: 'MEMBER_PENALTY_VIOLATION_CONFIRMED',
    };

    await expectError(
      await postCommand(memberId, 'add', body, { key: null }),
      400,
      'INVALID_IDEMPOTENCY_KEY'
    );
    await expectError(
      await postCommand(memberId, 'add', body, { key: 'k'.repeat(201) }),
      400,
      'INVALID_IDEMPOTENCY_KEY'
    );
    expect(await penaltyRows(memberId)).toHaveLength(0);
  });

  it('replays an Add with the original result and version token', async () => {
    const memberId = await createMember();
    const key = randomUUID();
    const body = {
      expectedVersionToken: 0,
      result: 'PENALTY_TEMPORARY_BAN_7_DAYS',
      reasonCode: 'MEMBER_PENALTY_VIOLATION_CONFIRMED',
      adminNote: 'Original note.',
    };
    const original = await expectCommand(await postCommand(memberId, 'add', body, { key }));
    const later = await addPenalty(memberId);

    const replay = await expectCommand(await postCommand(memberId, 'add', body, { key }));

    expect(replay).toEqual(original);
    expect(replay.versionToken).toBe(1);
    expect(await penaltyRows(memberId)).toHaveLength(2);
    expect(later.versionToken).toBe(2);
  });

  it('does not apply the Ban again when an Add replays after its Remove', async () => {
    const memberId = await createMember();
    const key = randomUUID();
    const body = {
      expectedVersionToken: 0,
      result: 'PENALTY_PERMANENT_BAN',
      reasonCode: 'MEMBER_PENALTY_SAFETY_RISK_CONFIRMED',
    };
    const original = await expectCommand(await postCommand(memberId, 'add', body, { key }));
    await removePenalty(memberId, original.recordId);

    const replay = await expectCommand(await postCommand(memberId, 'add', body, { key }));

    expect(replay).toEqual(original);
    expect(await penaltyRows(memberId)).toHaveLength(2);
    expect(await readMemberPenaltyRestriction(memberId)).toMatchObject({ banned: false });
    expect((await walletOf(memberId))?.walletStatus).toBe('ACTIVE');
  });

  it('replays a Remove with the original result and version token', async () => {
    const memberId = await createMember();
    const [first] = await recordStrikes(memberId, 3);
    const key = randomUUID();
    const body = {
      expectedVersionToken: 3,
      recordId: first!.id,
      reasonCode: 'MEMBER_PENALTY_NEW_EVIDENCE',
    };
    const original = await expectCommand(await postCommand(memberId, 'remove', body, { key }));
    expect(original.versionToken).toBe(8);
    await addPenalty(memberId);

    const replay = await expectCommand(await postCommand(memberId, 'remove', body, { key }));

    expect(replay).toEqual(original);
    expect(await penaltyRows(memberId)).toHaveLength(9);
  });

  it('keeps one record when the same command arrives twice at once', async () => {
    const memberId = await createMember();
    const key = randomUUID();
    const body = {
      expectedVersionToken: 0,
      result: 'PENALTY_PERMANENT_BAN',
      reasonCode: 'MEMBER_PENALTY_VIOLATION_CONFIRMED',
    };

    const [first, second] = await Promise.all([
      postCommand(memberId, 'add', body, { key }),
      postCommand(memberId, 'add', body, { key }),
    ]);

    expect(await expectCommand(second)).toEqual(await expectCommand(first));
    expect(await penaltyRows(memberId)).toHaveLength(1);
  });

  it.each([
    ['another result', { result: 'PENALTY_PERMANENT_BAN' }],
    ['no result', { result: undefined }],
    ['another reason code', { reasonCode: 'MEMBER_PENALTY_OTHER_VIOLATION_CONFIRMED' }],
    ['another note', { adminNote: 'Another note.' }],
    ['another version token', { expectedVersionToken: 1 }],
  ])('rejects reuse of an Add key with %s', async (_label, override) => {
    const memberId = await createMember();
    const key = randomUUID();
    const body = {
      expectedVersionToken: 0,
      result: 'PENALTY_RED_FLAG',
      reasonCode: 'MEMBER_PENALTY_VIOLATION_CONFIRMED',
    };
    await expectCommand(await postCommand(memberId, 'add', body, { key }));

    await expectError(
      await postCommand(memberId, 'add', { ...body, ...override }, { key }),
      409,
      'IDEMPOTENCY_KEY_REUSED'
    );

    expect(await penaltyRows(memberId)).toHaveLength(1);
  });

  it('rejects reuse of an Add key for another Member', async () => {
    const memberId = await createMember();
    const otherMemberId = await createMember();
    const key = randomUUID();
    const body = {
      expectedVersionToken: 0,
      result: 'PENALTY_PERMANENT_BAN',
      reasonCode: 'MEMBER_PENALTY_VIOLATION_CONFIRMED',
    };
    await expectCommand(await postCommand(memberId, 'add', body, { key }));

    await expectError(
      await postCommand(otherMemberId, 'add', body, { key }),
      409,
      'IDEMPOTENCY_KEY_REUSED'
    );

    expect(await penaltyRows(otherMemberId)).toHaveLength(0);
    expect(await readMemberPenaltyRestriction(otherMemberId)).toMatchObject({ banned: false });
  });

  it('rejects reuse of a Remove key with another request', async () => {
    const memberId = await createMember();
    const first = await addPenalty(memberId);
    const second = await addPenalty(memberId);
    const key = randomUUID();
    await expectCommand(
      await postCommand(
        memberId,
        'remove',
        {
          expectedVersionToken: 2,
          recordId: first.recordId,
          reasonCode: 'MEMBER_PENALTY_ADMIN_ERROR',
        },
        { key }
      )
    );

    await expectError(
      await postCommand(
        memberId,
        'remove',
        {
          expectedVersionToken: 2,
          recordId: second.recordId,
          reasonCode: 'MEMBER_PENALTY_ADMIN_ERROR',
        },
        { key }
      ),
      409,
      'IDEMPOTENCY_KEY_REUSED'
    );

    expect(await penaltyRows(memberId)).toHaveLength(3);
  });

  it('scopes a key to one Admin and one command kind', async () => {
    const memberId = await createMember();
    const otherAdmin = await createAdminSession();
    const key = randomUUID();
    const first = await addPenalty(memberId, 'PENALTY_RED_FLAG', { key });

    const otherAdminAdd = await addPenalty(memberId, 'PENALTY_RED_FLAG', {
      key,
      cookie: otherAdmin.cookie,
    });
    const sameKeyRemove = await removePenalty(memberId, first.recordId, { key });

    expect(otherAdminAdd.recordId).not.toBe(first.recordId);
    expect(sameKeyRemove).toMatchObject({ kind: 'REMOVE', recordId: first.recordId });
    expect(await penaltyRows(memberId)).toHaveLength(3);
  });
});

describe('Direct results and the automatic Misconduct ladder', () => {
  it('does not count direct results toward a later automatic result', async () => {
    const memberId = await createMember();
    await addPenalty(memberId, 'PENALTY_PERMANENT_BAN');
    await addPenalty(memberId, 'PENALTY_TEMPORARY_BAN_7_DAYS');
    await addPenalty(memberId, 'PENALTY_RED_FLAG');

    const firstStrike = await recordStrike(memberId);
    const secondStrike = await recordStrike(memberId);

    expect(firstStrike.result).toBe('PENALTY_RED_FLAG');
    expect(secondStrike.result).toBe('PENALTY_TEMPORARY_BAN_7_DAYS');
  });

  it('does not consume the Report Case exemption with a direct result', async () => {
    const memberId = await createMember();
    await addPenalty(memberId, 'PENALTY_RED_FLAG');

    const firstReportCase = await recordStrike(memberId, 'REPORT_CASE');

    expect(firstReportCase.result).toBe('PENALTY_EXEMPT');
  });

  it('keeps a direct result as selected when a Remove recalculates automatic results', async () => {
    const memberId = await createMember();
    const directBefore = await addPenalty(memberId, 'PENALTY_TEMPORARY_BAN_7_DAYS');
    const [firstStrike, secondStrike] = await recordStrikes(memberId, 2);
    const directAfter = await addPenalty(memberId, 'PENALTY_RED_FLAG');
    const token = await currentToken(memberId);

    const command = await removePenalty(memberId, firstStrike!.id);

    expect(command.versionToken).toBe(token + 3);
    const rows = await penaltyRows(memberId);
    expect(rows).toHaveLength(token + 3);
    for (const direct of [directBefore, directAfter]) {
      expect(rows.some((row) => row.reversalOfRecordId === direct.recordId)).toBe(false);
      expect(rows.some((row) => row.recalculationOfRecordId === direct.recordId)).toBe(false);
    }
    expect(rows.find((row) => row.recalculationOfRecordId === secondStrike!.id)?.result).toBe(
      'PENALTY_RED_FLAG'
    );
  });

  it('does not recalculate automatic results when a direct result is removed', async () => {
    const memberId = await createMember();
    const direct = await addPenalty(memberId, 'PENALTY_PERMANENT_BAN');
    const [firstStrike, secondStrike] = await recordStrikes(memberId, 2);

    const command = await removePenalty(memberId, direct.recordId);

    expect(command.versionToken).toBe(4);
    const { items } = await readHistory(memberId);
    expect(items).toHaveLength(4);
    for (const [strike, result] of [
      [firstStrike!, 'PENALTY_RED_FLAG'],
      [secondStrike!, 'PENALTY_TEMPORARY_BAN_7_DAYS'],
    ] as const) {
      expect(items.find((item) => item.recordId === strike.id)).toMatchObject({
        result,
        isEffective: true,
        replacedBy: null,
      });
    }
  });
});

describe('Recalculation of later automatic results', () => {
  it('appends a linked reversal and replacement for each changed result', async () => {
    const memberId = await createMember();
    const [first, second, third] = await recordStrikes(memberId, 3);
    expect([first!.result, second!.result, third!.result]).toEqual([
      'PENALTY_RED_FLAG',
      'PENALTY_TEMPORARY_BAN_7_DAYS',
      'PENALTY_PERMANENT_BAN',
    ]);

    const command = await removePenalty(memberId, first!.id, { adminNote: 'Wrong Member.' });

    expect(command.versionToken).toBe(8);
    expect(await currentToken(memberId)).toBe(8);
    const rows = await penaltyRows(memberId);
    expect(rows).toHaveLength(8);
    expect(rows.find((row) => row.id === first!.id)).toEqual(first!);
    expect(rows.find((row) => row.id === second!.id)).toEqual(second!);
    expect(rows.find((row) => row.id === third!.id)).toEqual(third!);

    for (const [original, result] of [
      [second!, 'PENALTY_RED_FLAG'],
      [third!, 'PENALTY_TEMPORARY_BAN_7_DAYS'],
    ] as const) {
      expect(rows.find((row) => row.reversalOfRecordId === original.id)).toMatchObject({
        result: 'PENALTY_REVERSAL',
        source: original.source,
        sourceId: original.sourceId,
        sequenceNumber: original.sequenceNumber,
        reasonCode: 'MEMBER_PENALTY_ADMIN_ERROR',
        adminNote: 'Wrong Member.',
        commandKind: null,
      });
      expect(rows.find((row) => row.recalculationOfRecordId === original.id)).toMatchObject({
        result,
        source: original.source,
        sourceId: original.sourceId,
        sequenceNumber: original.sequenceNumber,
        reasonCode: 'MEMBER_PENALTY_ADMIN_ERROR',
        adminNote: 'Wrong Member.',
        commandKind: null,
      });
    }

    const { items } = await readHistory(memberId);
    const replacementForThird = rows.find((row) => row.recalculationOfRecordId === third!.id)!;
    expect(items.find((item) => item.recordId === third!.id)).toMatchObject({
      isEffective: false,
      replacedBy: { result: 'PENALTY_TEMPORARY_BAN_7_DAYS' },
    });
    expect(items.find((item) => item.recordId === replacementForThird.id)).toMatchObject({
      isEffective: true,
      recalculatedFrom: { result: 'PENALTY_PERMANENT_BAN' },
    });
  });

  it('continues the ladder from the remaining effective strikes', async () => {
    const memberId = await createMember();
    const [first] = await recordStrikes(memberId, 2);

    await removePenalty(memberId, first!.id);
    const nextStrike = await recordStrike(memberId);

    expect(nextStrike.result).toBe('PENALTY_TEMPORARY_BAN_7_DAYS');
  });

  it('appends no recalculation rows when the last strike is removed', async () => {
    const memberId = await createMember();
    const strikes = await recordStrikes(memberId, 3);

    const command = await removePenalty(memberId, strikes[2]!.id);

    expect(command.versionToken).toBe(4);
    expect(await penaltyRows(memberId)).toHaveLength(4);
    expect(await readMemberPenaltyRestriction(memberId)).toMatchObject({
      banned: true,
      permanentlyBanned: false,
    });
  });

  it('removes a recalculated replacement and recalculates again', async () => {
    const memberId = await createMember();
    const [first, second, third] = await recordStrikes(memberId, 3);
    await removePenalty(memberId, first!.id);
    const replacementForSecond = (await penaltyRows(memberId)).find(
      (row) => row.recalculationOfRecordId === second!.id
    )!;
    const replacementForThird = (await penaltyRows(memberId)).find(
      (row) => row.recalculationOfRecordId === third!.id
    )!;

    const command = await removePenalty(memberId, replacementForSecond.id);

    expect(command.versionToken).toBe(11);
    expect(
      (await penaltyRows(memberId)).find(
        (row) => row.recalculationOfRecordId === replacementForThird.id
      )?.result
    ).toBe('PENALTY_RED_FLAG');
    expect(await readMemberPenaltyRestriction(memberId)).toMatchObject({
      banned: false,
      redFlagged: true,
    });
  });

  it('recalculates the Review ladder without changing the Misconduct ladder', async () => {
    const memberId = await createMember();
    const strike = await recordStrike(memberId);
    const createdAt = new Date();
    const reviewRecordIds = [randomUUID(), randomUUID(), randomUUID()];
    await db.insert(memberPenaltyRecord).values(
      (
        [
          'PENALTY_TEMPORARY_BAN_7_DAYS',
          'PENALTY_TEMPORARY_BAN_1_MONTH',
          'PENALTY_PERMANENT_BAN',
        ] as const
      ).map((result, index) => ({
        id: reviewRecordIds[index]!,
        memberId,
        ladder: 'REVIEW' as const,
        source: 'REVIEW_AVERAGE' as const,
        sourceId: randomUUID(),
        sequenceNumber: index + 1,
        result,
        actorType: 'SYSTEM' as const,
        reasonCode: 'REVIEW_AVERAGE_LOW',
        createdAt,
      }))
    );

    const command = await removePenalty(memberId, reviewRecordIds[0]!);

    expect(command.versionToken).toBe(9);
    const rows = await penaltyRows(memberId);
    expect(rows.find((row) => row.recalculationOfRecordId === reviewRecordIds[1])?.result).toBe(
      'PENALTY_TEMPORARY_BAN_7_DAYS'
    );
    expect(rows.find((row) => row.recalculationOfRecordId === reviewRecordIds[2])?.result).toBe(
      'PENALTY_TEMPORARY_BAN_1_MONTH'
    );
    expect(rows.some((row) => row.reversalOfRecordId === strike.id)).toBe(false);
    expect(rows.some((row) => row.recalculationOfRecordId === strike.id)).toBe(false);
    expect(await readMemberPenaltyRestriction(memberId)).toMatchObject({
      banned: true,
      permanentlyBanned: false,
      redFlagged: true,
    });
  });
});

describe('Member restrictions and penalty-created Wallet state', () => {
  it.each(['PENALTY_TEMPORARY_BAN_7_DAYS', 'PENALTY_PERMANENT_BAN'] as const)(
    'blocks sign-in and freezes the Wallet on %s, then restores both on Remove',
    async (result) => {
      const member = await signUpMember();
      const wallet = await ensureWallet(member.id);
      expect((await memberRequest(member.cookie)).status).toBe(200);

      const added = await addPenalty(member.id, result);

      const blockedRequest = await memberRequest(member.cookie);
      await expectError(blockedRequest, 403, 'MEMBER_BANNED');
      expect((await member.signIn()).status).toBe(403);
      expect((await walletOf(member.id))?.walletStatus).toBe('FROZEN');
      const [freeze] = await walletHistory(wallet.id);
      expect(freeze).toMatchObject({
        fromStatus: 'ACTIVE',
        toStatus: 'FROZEN',
        actorAdminId: null,
        actorUserId: null,
        reason: `Automatic Member Ban freeze: ${added.recordId}`,
      });

      await removePenalty(member.id, added.recordId);

      expect((await memberRequest(member.cookie)).status).toBe(200);
      expect((await member.signIn()).status).toBe(200);
      expect((await walletOf(member.id))?.walletStatus).toBe('ACTIVE');
      const [restore] = await walletHistory(wallet.id);
      expect(restore).toMatchObject({
        fromStatus: 'FROZEN',
        toStatus: 'ACTIVE',
        actorAdminId: null,
        actorUserId: null,
      });
      expect(await authProjection(member.id)).toEqual({
        bannedUntil: null,
        redFlagExpiresAt: null,
      });
    }
  );

  it('creates and freezes a Wallet when a banned Member has no Wallet', async () => {
    const memberId = await createMember();
    expect(await walletOf(memberId)).toBeUndefined();

    await addPenalty(memberId, 'PENALTY_TEMPORARY_BAN_7_DAYS');

    expect((await walletOf(memberId))?.walletStatus).toBe('FROZEN');
  });

  it('does not block sign-in or freeze the Wallet on a Red Flag', async () => {
    const member = await signUpMember();
    const wallet = await ensureWallet(member.id);
    const historyBefore = await walletHistory(wallet.id);

    const added = await addPenalty(member.id, 'PENALTY_RED_FLAG');

    expect((await memberRequest(member.cookie)).status).toBe(200);
    expect((await member.signIn()).status).toBe(200);
    expect((await walletOf(member.id))?.walletStatus).toBe('ACTIVE');

    await removePenalty(member.id, added.recordId);

    expect(await readMemberPenaltyRestriction(member.id)).toMatchObject({ redFlagged: false });
    expect(await walletHistory(wallet.id)).toHaveLength(historyBefore.length);
  });

  it('keeps the freeze and sign-in block until the last active Ban is removed', async () => {
    const member = await signUpMember();
    const wallet = await ensureWallet(member.id);
    const temporary = await addPenalty(member.id, 'PENALTY_TEMPORARY_BAN_7_DAYS');
    const historyAfterFreeze = await walletHistory(wallet.id);
    const permanent = await addPenalty(member.id, 'PENALTY_PERMANENT_BAN');
    expect((await walletOf(member.id))?.walletStatus).toBe('FROZEN');
    expect(await walletHistory(wallet.id)).toHaveLength(historyAfterFreeze.length);

    await removePenalty(member.id, temporary.recordId);

    expect((await member.signIn()).status).toBe(403);
    expect((await walletOf(member.id))?.walletStatus).toBe('FROZEN');
    expect(await walletHistory(wallet.id)).toHaveLength(historyAfterFreeze.length);
    expect(await readMemberPenaltyRestriction(member.id)).toMatchObject({
      bannedUntil: null,
      permanentlyBanned: true,
    });

    await removePenalty(member.id, permanent.recordId);

    expect((await member.signIn()).status).toBe(200);
    expect((await walletOf(member.id))?.walletStatus).toBe('ACTIVE');
  });

  it('changes a permanent Ban to the recalculated temporary Ban on Remove', async () => {
    const member = await signUpMember();
    await ensureWallet(member.id);
    const [first] = await recordStrikes(member.id, 3);
    expect(await readMemberPenaltyRestriction(member.id)).toMatchObject({
      permanentlyBanned: true,
    });

    await removePenalty(member.id, first!.id);

    const restriction = await readMemberPenaltyRestriction(member.id);
    expect(restriction).toMatchObject({
      banned: true,
      permanentlyBanned: false,
      redFlagged: true,
    });
    expectAboutSevenDaysFromNow(restriction.bannedUntil);
    expectAboutSevenDaysFromNow(restriction.redFlagExpiresAt);
    expect((await member.signIn()).status).toBe(403);
    expect((await walletOf(member.id))?.walletStatus).toBe('FROZEN');
  });

  it('restores sign-in and the Wallet when recalculation removes the only Ban', async () => {
    const member = await signUpMember();
    await ensureWallet(member.id);
    const [first] = await recordStrikes(member.id, 2);
    expect((await walletOf(member.id))?.walletStatus).toBe('FROZEN');
    expect((await member.signIn()).status).toBe(403);

    await removePenalty(member.id, first!.id);

    const restriction = await readMemberPenaltyRestriction(member.id);
    expect(restriction).toMatchObject({ banned: false, redFlagged: true });
    expect((await member.signIn()).status).toBe(200);
    expect((await walletOf(member.id))?.walletStatus).toBe('ACTIVE');
  });

  it('keeps a discretionary Wallet Freeze set before the Ban', async () => {
    const memberId = await createMember();
    const wallet = await ensureWallet(memberId);
    await changeWalletStatus(wallet.id, 'FROZEN');

    const added = await addPenalty(memberId, 'PENALTY_PERMANENT_BAN');
    const historyAfterAdd = await walletHistory(wallet.id);
    await removePenalty(memberId, added.recordId);

    expect(await readMemberPenaltyRestriction(memberId)).toMatchObject({ banned: false });
    expect((await walletOf(memberId))?.walletStatus).toBe('FROZEN');
    expect(await walletHistory(wallet.id)).toHaveLength(historyAfterAdd.length);
    expect(historyAfterAdd[0]).toMatchObject({ toStatus: 'FROZEN', actorAdminId: adminId });
  });

  it('keeps a discretionary Wallet Freeze set after the penalty freeze', async () => {
    const memberId = await createMember();
    const wallet = await ensureWallet(memberId);
    const added = await addPenalty(memberId, 'PENALTY_TEMPORARY_BAN_7_DAYS');
    await changeWalletStatus(wallet.id, 'ACTIVE');
    await changeWalletStatus(wallet.id, 'FROZEN');

    await removePenalty(memberId, added.recordId);

    expect((await walletOf(memberId))?.walletStatus).toBe('FROZEN');
    const [latest] = await walletHistory(wallet.id);
    expect(latest).toMatchObject({ toStatus: 'FROZEN', actorAdminId: adminId });
  });

  it('keeps a discretionary Wallet Suspend', async () => {
    const memberId = await createMember();
    const wallet = await ensureWallet(memberId);
    await changeWalletStatus(wallet.id, 'SUSPENDED');

    const added = await addPenalty(memberId, 'PENALTY_PERMANENT_BAN');
    expect((await walletOf(memberId))?.walletStatus).toBe('SUSPENDED');
    await removePenalty(memberId, added.recordId);

    expect((await walletOf(memberId))?.walletStatus).toBe('SUSPENDED');
  });

  it('does not change a Wallet that has a discretionary Freeze when no Ban was active', async () => {
    const memberId = await createMember();
    const wallet = await ensureWallet(memberId);
    await changeWalletStatus(wallet.id, 'FROZEN');
    const added = await addPenalty(memberId, 'PENALTY_RED_FLAG');

    await removePenalty(memberId, added.recordId);

    expect((await walletOf(memberId))?.walletStatus).toBe('FROZEN');
  });
});
