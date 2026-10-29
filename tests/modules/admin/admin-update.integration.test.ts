import { app } from '@/app';
import { env } from '@/config/env';
import { db, sql } from '@/database/client';
import { authAdmin, authUser } from '@/database/schema/auth.schema';
import { walletLedgerAccount, walletWallet } from '@/database/schema/wallet.schema';
import { quest, questCommand } from '@/database/schema/quest.schema';
import { tag } from '@/database/schema/tag.schema';
import {
  createSealedLedgerTransaction,
  ensureInitialMoneyPolicy,
  ensureWallet,
  positiveSatang,
  signedSatang,
} from '@/modules/wallet';
import {
  adminUpdateListenerApplicationName,
  notifyAdminResourceUpdated,
  stopAdminUpdateListener,
} from '@/modules/admin/admin-update.delivery';
import { parseAdminUpdateNotification } from '@/modules/admin/admin-update.schema';
import { auth } from '@/modules/auth';
import { createAdminAuth } from '@/modules/auth/admin-auth.config';
import {
  createPayoutDestinationEncryption,
  savePayoutDestination,
} from '@/modules/payout-destination';
import { initiatePayout, quotePayout } from '@/modules/payout';
import {
  createProviderEventEncryption,
  initiateTopUp,
  processTopUpProviderEvent,
  quoteTopUp,
  receiveTopUpProviderEvent,
} from '@/modules/top-up';
import type {
  InboundPaymentProvider,
  InboundPaymentRequest,
  InboundPaymentResponse,
} from '@/modules/top-up';
import { updateProfile } from '@/modules/profile/profile.service';
import { createQuestV2, type QuestV2CreateInput } from '@/modules/quest';

import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test';

const adminPassword = 'AdminUpdatePass1!';
const adminEmails = [
  `admin-update-one-${crypto.randomUUID()}@example.com`,
  `admin-update-two-${crypto.randomUUID()}@example.com`,
];
let databaseReady = false;
const adminIds: string[] = [];
const adminCookies: string[] = [];
const providerEventEncryption = createProviderEventEncryption({
  activeKeyVersion: 'v1',
  keys: { v1: 'a'.repeat(32) },
});
const payoutDestinationEncryption = createPayoutDestinationEncryption({
  activeKeyVersion: 'v1',
  keys: { v1: 'p'.repeat(32) },
});

class AdminUpdatePaymentProvider implements InboundPaymentProvider {
  async createPayment(input: InboundPaymentRequest): Promise<InboundPaymentResponse> {
    return {
      providerReference: `admin-update-pr-${crypto.randomUUID()}`,
      providerStatus: 'REQUIRES_ACTION',
      providerAmountSatang: input.paymentTotalSatang,
      providerApiVersion: 'admin-update-test-v1',
      providerChannelCode: 'QRPROMPTPAY',
      qrPayload: 'admin-update-test-qr',
      qrExpiresAt: input.expiresAt,
    };
  }
}

const getCookieHeader = (response: Response): string =>
  (response.headers.getSetCookie?.() ?? []).map((cookie) => cookie.split(';', 1)[0]).join('; ');

const loginAdmin = async (email: string) => {
  const adminAuth = createAdminAuth({
    allowSignUp: true,
    autoSignIn: false,
    markEmailVerified: true,
  });
  const account = await adminAuth.api.signUpEmail({
    body: {
      email,
      password: adminPassword,
      name: 'Update Admin',
      firstName: 'Update',
      lastName: 'Admin',
    },
  });
  const response = await app.handle(
    new Request('http://localhost/api/admin/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: adminPassword }),
    })
  );
  if (response.status !== 200) throw new Error(`Admin sign-in failed: ${response.status}`);
  return { id: account.user.id, cookie: getCookieHeader(response) };
};

const createPendingTopUp = async (userId: string) => {
  const quote = await quoteTopUp({
    principalUserId: userId,
    creditSatang: positiveSatang(100),
  });
  const topUp = await initiateTopUp(
    {
      principalUserId: userId,
      quoteId: quote.id,
      idempotency: { key: `admin-update-${crypto.randomUUID()}` },
    },
    new AdminUpdatePaymentProvider()
  );
  const rawPayload = JSON.stringify({
    event_id: `admin-update-event-${crypto.randomUUID()}`,
    event: 'payment.capture',
    data: {
      reference_id: topUp.internalReference,
      payment_request_id: topUp.providerReference,
      status: 'SUCCEEDED',
      request_amount: topUp.paymentTotalSatang / 100,
      channel_code: 'QRPROMPTPAY',
      updated: '2026-10-30T00:00:00.000Z',
    },
  });
  const providerEvent = await receiveTopUpProviderEvent({
    rawPayload,
    callbackToken: 'admin-update-test-token',
    webhookToken: 'admin-update-test-token',
    encryption: providerEventEncryption,
  });
  return { topUp, providerEvent };
};

const preparePendingPayoutQuote = async (userId: string) => {
  await savePayoutDestination(
    {
      principalUserId: userId,
      givenName: 'Update',
      surname: 'Member',
      relationship: 'SELF',
      bankCode: 'SCB',
      accountNumber: '1234567890',
      accountHolderName: 'Update Member',
      routingType: 'BANK_ACCOUNT',
      routingValue: '1234567890',
    },
    payoutDestinationEncryption
  );

  const walletAccounts = await db
    .select({ id: walletLedgerAccount.id, type: walletLedgerAccount.type })
    .from(walletLedgerAccount)
    .innerJoin(walletWallet, eq(walletLedgerAccount.walletId, walletWallet.id))
    .where(eq(walletWallet.userId, userId));
  const [suspenseAccount] = await db
    .select({ id: walletLedgerAccount.id })
    .from(walletLedgerAccount)
    .where(eq(walletLedgerAccount.code, 'platform:PLATFORM_SUSPENSE'));
  const earningsAccount = walletAccounts.find((account) => account.type === 'EARNINGS');
  if (!earningsAccount || !suspenseAccount)
    throw new Error('Wallet accounts were not provisioned.');

  await createSealedLedgerTransaction({
    businessReference: `admin-update-credit:${crypto.randomUUID()}`,
    eventType: 'ADJUSTMENT',
    postings: [
      { accountId: earningsAccount.id, amountSatang: signedSatang(1_000) },
      { accountId: suspenseAccount.id, amountSatang: signedSatang(-1_000) },
    ],
  });

  const quote = await quotePayout({
    principalUserId: userId,
    receiptSatang: positiveSatang(100),
  });
  return quote;
};

const adminEventsRequest = (cookie = adminCookies[0]!, origin?: string) =>
  app.handle(
    new Request('http://localhost/api/v1/admin/events', {
      headers: {
        cookie,
        ...(origin ? { origin } : {}),
      },
    })
  );

type AdminSseReadResult = Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']>>;

const pendingReads = new WeakMap<
  ReadableStreamDefaultReader<Uint8Array>,
  Promise<AdminSseReadResult>
>();

const readNextChunk = (reader: ReadableStreamDefaultReader<Uint8Array>) => {
  let pending = pendingReads.get(reader);
  if (!pending) {
    pending = reader.read().finally(() => pendingReads.delete(reader));
    pendingReads.set(reader, pending);
  }
  return pending;
};

const pendingTextBuffers = new WeakMap<ReadableStreamDefaultReader<Uint8Array>, string>();

const readWithTimeout = async (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMessage: string,
  timeoutMs: number
) => {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      readNextChunk(reader),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
};

const readProcessOutputLine = async (reader: ReadableStreamDefaultReader<Uint8Array>) => {
  const next = await readWithTimeout(reader, 'Timed out waiting for API process output.', 5_000);
  if (next.done) throw new Error('API process exited before it reported its port.');
  return new TextDecoder().decode(next.value);
};

const readText = async (reader: ReadableStreamDefaultReader<Uint8Array>, timeoutMs = 5_000) => {
  let buffer = pendingTextBuffers.get(reader) ?? '';
  while (true) {
    const frameEnd = buffer.indexOf('\n\n');
    if (frameEnd >= 0) {
      const frame = buffer.slice(0, frameEnd);
      pendingTextBuffers.set(reader, buffer.slice(frameEnd + 2));
      return frame;
    }

    const next = await readWithTimeout(reader, 'Timed out waiting for Admin SSE data.', timeoutMs);
    if (next.done) throw new Error('Admin SSE stream closed before the expected event.');
    buffer += new TextDecoder().decode(next.value);
    pendingTextBuffers.set(reader, buffer);
  }
};

const expectStreamToClose = async (reader: ReadableStreamDefaultReader<Uint8Array>) => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = await readWithTimeout(
      reader,
      'Timed out waiting for Admin SSE stream to close.',
      deadline - Date.now()
    );
    if (result.done) return;
  }
  throw new Error('Timed out waiting for Admin SSE stream to close.');
};

const readEvent = async (reader: ReadableStreamDefaultReader<Uint8Array>, timeoutMs = 5_000) => {
  const frame = await readText(reader, timeoutMs);
  const data = frame.split('\n').find((line) => line.startsWith('data: '));
  if (!data) throw new Error(`Admin SSE frame did not contain event data: ${frame}`);
  return JSON.parse(data.slice('data: '.length)) as Record<string, unknown>;
};

const readEventFor = async (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  subjectType: string,
  subjectId: string
) => {
  while (true) {
    const event = await readEvent(reader);
    if (event.subjectType === subjectType && event.subjectId === subjectId) return event;
  }
};

const readEventsUntil = async (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  matches: Array<(event: Record<string, unknown>) => boolean>
) => {
  const remaining = [...matches];
  const events: Record<string, unknown>[] = [];
  while (remaining.length > 0) {
    const event = await readEvent(reader);
    events.push(event);
    const matched = remaining.findIndex((matchesEvent) => matchesEvent(event));
    if (matched >= 0) remaining.splice(matched, 1);
  }
  return events;
};

const expectNoEventFor = async (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  subjectType: string,
  subjectId: string,
  timeoutMs = 250
) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let frame: string;
    try {
      frame = await readText(reader, deadline - Date.now());
    } catch (error) {
      if (error instanceof Error && error.message === 'Timed out waiting for Admin SSE data.')
        return;
      throw error;
    }
    const dataLine = frame.split('\n').find((line) => line.startsWith('data: '));
    if (!dataLine) continue;
    const event = JSON.parse(dataLine.slice('data: '.length)) as Record<string, unknown>;
    if (event.subjectType === subjectType && event.subjectId === subjectId) {
      throw new Error(`Received a duplicate Admin SSE event: ${JSON.stringify(event)}`);
    }
  }
};

beforeAll(async () => {
  try {
    await sql`select 1`;
    const [tables] = await sql<{ admin: string | null }[]>`
      select to_regclass('public.auth_admin') as admin
    `;
    databaseReady = tables?.admin !== null;
  } catch {
    console.warn('Skipping Admin update tests: PostgreSQL is unavailable');
    return;
  }
  if (!databaseReady) return;

  const admins = await Promise.all(adminEmails.map(loginAdmin));
  adminIds.push(...admins.map(({ id }) => id));
  adminCookies.push(...admins.map(({ cookie }) => cookie));
});

afterAll(async () => {
  await stopAdminUpdateListener();
  if (!databaseReady) return;
  if (adminIds.length > 0)
    await db
      .update(authAdmin)
      .set({ disabledAt: new Date() })
      .where(inArray(authAdmin.id, adminIds));
});

describe('Admin SSE updates', () => {
  it('documents the SSE media type, event contract, and access errors in OpenAPI', async () => {
    if (!databaseReady) return;
    const response = await app.handle(new Request('http://localhost/openapi/json'));
    const document = (await response.json()) as {
      paths: Record<
        string,
        Record<
          string,
          {
            operationId?: string;
            description?: string;
            security?: Array<Record<string, unknown>>;
            responses?: Record<
              string,
              {
                content?: Record<string, { example?: string; examples?: Record<string, unknown> }>;
              }
            >;
          }
        >
      >;
    };
    const operation = document.paths['/api/v1/admin/events']?.get;

    expect(response.status).toBe(200);
    expect(operation?.operationId).toBe('subscribeAdminUpdates');
    expect(operation?.description).toContain('GET /api/v1/admin/reports/{reportId}');
    expect(operation?.description).not.toContain('relatedSubjects');
    expect(operation?.description).toContain('GET /api/v1/admin/members');
    expect(operation?.description).toContain('GET /api/v1/admin/members/{id}');
    expect(operation?.description).toContain('GET /api/v1/admin/wallets/{walletId}');
    expect(operation?.description).toContain('GET /api/v1/admin/wallets/{walletId}/status-history');
    expect(operation?.description).toContain('GET /api/v1/admin/payouts/{payoutId}/status-history');
    expect(operation?.description).toContain('GET /api/v1/admin/top-ups/{topUpId}/status-history');
    expect(operation?.description).toContain('GET /api/v1/admin/finance/overview');
    expect(operation?.description).toContain('GET /api/v1/admin/overview');
    expect(operation?.description).toContain('GET /api/v1/admin/quests/{questId}');
    expect(operation?.description).toContain('GET /api/v1/admin/members/{memberId}');
    expect(operation?.description).toContain('GET /api/v1/admin/members/{id}/penalty-history');
    expect(operation?.description).toContain('GET /api/v1/admin/activity-log');
    expect(operation?.description).toContain('GET /api/v1/admin/disputes/{disputeCaseId}');
    expect(operation?.description).toContain('GET /api/v1/admin/finance/quests/{questId}');
    expect(operation?.description).toContain('GET /api/v1/admin/wallets/{walletId}');
    expect(operation?.description).toContain('GET /api/v1/admin/finance/members/{userId}');
    expect(operation?.description).toContain('data.wallet.id');
    expect(operation?.description).toContain('data.member.userId');
    expect(operation?.description).toContain('matches the Wallet event `subjectId`');
    expect(operation?.description).toContain('active Funding Reservations');
    expect(operation?.description).toContain(
      'GET /api/v1/admin/finance/ledger/transactions?walletId={walletId}'
    );
    expect(operation?.description).toContain('Other resource types need a documented read mapping');
    expect(operation?.security?.[0]).toHaveProperty('betterAuthAdminSession');
    expect(operation?.responses).toHaveProperty('401');
    expect(operation?.responses).toHaveProperty('403');
    expect(operation?.responses).toHaveProperty('503');
    expect(operation?.responses?.['200']?.content).toHaveProperty('text/event-stream');
    expect(operation?.responses?.['200']?.content?.['text/event-stream']?.example).toContain(
      'CONDUCT_REPORT'
    );
  });

  it('publishes Quest creation and Member profile changes through the Admin stream', async () => {
    if (!databaseReady) return;

    const memberId = crypto.randomUUID();
    const tagId = crypto.randomUUID();
    let questId: string | undefined;
    await db.insert(authUser).values({
      id: memberId,
      email: `${memberId}@ku.th`,
      firstName: 'SSE',
      lastName: 'Member',
    });
    await db.insert(tag).values({ id: tagId, name: `Admin SSE ${tagId}` });

    const response = await adminEventsRequest();
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    try {
      expect(await readText(reader)).toContain(': connected');
      const input: QuestV2CreateInput = {
        title: 'Admin event Quest',
        description: 'A Quest created for Admin invalidation coverage.',
        condition: { items: ['Complete the work'] },
        mode: 'FIRST_COME_FIRST_SERVED',
        participation: 'SINGLE',
        questFundingTotal: 10,
        headcount: 1,
        startTime: '2030-08-26T10:00:00.000+07:00',
        dueAt: '2030-08-26T12:00:00.000+07:00',
        tagId,
        proofRequired: false,
        locations: [],
      };
      const created = await createQuestV2(memberId, input, `admin-update-${crypto.randomUUID()}`);
      if (!('quest' in created)) throw new Error(`Quest create failed: ${created.outcome}`);
      questId = created.quest.id;

      expect(await readEvent(reader)).toEqual({
        type: 'RESOURCE_UPDATED',
        subjectType: 'QUEST',
        subjectId: questId,
      });
      expect(await readEvent(reader)).toEqual({
        type: 'RESOURCE_UPDATED',
        subjectType: 'MEMBER',
        subjectId: memberId,
      });

      expect(await updateProfile(memberId, { bio: 'Updated by Member' })).toBe('updated');
      expect(await readEvent(reader)).toEqual({
        type: 'RESOURCE_UPDATED',
        subjectType: 'MEMBER',
        subjectId: memberId,
      });
    } finally {
      await reader.cancel();
      if (questId) await db.delete(quest).where(eq(quest.id, questId));
      await db.delete(tag).where(eq(tag.id, tagId));
      await db.delete(questCommand).where(eq(questCommand.principalUserId, memberId));
      await db.delete(authUser).where(eq(authUser.id, memberId));
    }
  });

  it('does not publish rolled-back Quest or Member mutations through the Admin stream', async () => {
    if (!databaseReady) return;

    const hirerId = crypto.randomUUID();
    const rolledBackMemberId = crypto.randomUUID();
    const committedMemberId = crypto.randomUUID();
    const tagId = crypto.randomUUID();
    let questId: string | undefined;
    await db.insert(authUser).values([
      {
        id: hirerId,
        email: `${hirerId}@ku.th`,
        firstName: 'Rollback',
        lastName: 'Hirer',
      },
      {
        id: rolledBackMemberId,
        email: `${rolledBackMemberId}@ku.th`,
        firstName: 'Rollback',
        lastName: 'Member',
      },
      {
        id: committedMemberId,
        email: `${committedMemberId}@ku.th`,
        firstName: 'Committed',
        lastName: 'Member',
      },
    ]);
    await db.insert(tag).values({ id: tagId, name: `Admin SSE rollback ${tagId}` });

    try {
      const input: QuestV2CreateInput = {
        title: 'Rollback event Quest',
        description: 'A Quest for rollback coverage.',
        condition: { items: ['Complete the work'] },
        mode: 'FIRST_COME_FIRST_SERVED',
        participation: 'SINGLE',
        questFundingTotal: 10,
        headcount: 1,
        startTime: '2030-08-26T10:00:00.000+07:00',
        dueAt: '2030-08-26T12:00:00.000+07:00',
        tagId,
        proofRequired: false,
        locations: [],
      };
      const created = await createQuestV2(hirerId, input, `admin-rollback-${crypto.randomUUID()}`);
      if (!('quest' in created)) throw new Error(`Quest create failed: ${created.outcome}`);
      questId = created.quest.id;

      const response = await adminEventsRequest();
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      try {
        expect(await readText(reader)).toContain(': connected');
        await expect(
          db.transaction(async (transaction) => {
            const [updatedQuest] = await transaction
              .update(quest)
              .set({ description: 'This Quest change must roll back.' })
              .where(eq(quest.id, questId!))
              .returning({ id: quest.id });
            expect(updatedQuest?.id).toBe(questId!);
            await notifyAdminResourceUpdated(transaction, 'QUEST', questId!);
            throw new Error('force Quest rollback');
          })
        ).rejects.toThrow('force Quest rollback');

        await expect(
          db.transaction(async (transaction) => {
            await transaction
              .update(authUser)
              .set({ bio: 'This Member update must roll back.' })
              .where(eq(authUser.id, rolledBackMemberId));
            await notifyAdminResourceUpdated(transaction, 'MEMBER', rolledBackMemberId);
            throw new Error('force Member rollback');
          })
        ).rejects.toThrow('force Member rollback');

        const [questRow] = await db
          .select({ description: quest.description })
          .from(quest)
          .where(eq(quest.id, questId));
        const [rolledBackMember] = await db
          .select({ bio: authUser.bio })
          .from(authUser)
          .where(eq(authUser.id, rolledBackMemberId));
        expect(questRow?.description).toBe('A Quest for rollback coverage.');
        expect(rolledBackMember?.bio).toBeNull();

        expect(await updateProfile(committedMemberId, { bio: 'Committed update' })).toBe('updated');
        expect(await readEvent(reader)).toEqual({
          type: 'RESOURCE_UPDATED',
          subjectType: 'MEMBER',
          subjectId: committedMemberId,
        });
      } finally {
        await reader.cancel();
      }
    } finally {
      if (questId) await db.delete(quest).where(eq(quest.id, questId));
      await db.delete(tag).where(eq(tag.id, tagId));
      await db
        .delete(questCommand)
        .where(
          inArray(questCommand.principalUserId, [hirerId, rolledBackMemberId, committedMemberId])
        );
      await db
        .delete(authUser)
        .where(inArray(authUser.id, [hirerId, rolledBackMemberId, committedMemberId]));
    }
  });

  it('allows enabled Admins and rejects anonymous, Member, disabled, and untrusted-origin callers', async () => {
    if (!databaseReady) return;

    const anonymous = await app.handle(new Request('http://localhost/api/v1/admin/events'));
    expect(anonymous.status).toBe(401);

    const memberAuth = spyOn(auth.api, 'getSession').mockImplementation((async ({
      headers,
    }: {
      headers: Headers;
    }) =>
      headers.get('x-test-member')
        ? ({ user: { id: 'member-test' }, session: { userId: 'member-test' } } as never)
        : null) as never);
    try {
      const member = await app.handle(
        new Request('http://localhost/api/v1/admin/events', {
          headers: { 'x-test-member': 'member-test' },
        })
      );
      expect(member.status).toBe(403);
    } finally {
      memberAuth.mockRestore();
    }

    const [admin] = await db
      .select({ id: authAdmin.id })
      .from(authAdmin)
      .where(eq(authAdmin.id, adminIds[0]!));
    if (!admin) throw new Error('Admin test account is missing.');
    await db.update(authAdmin).set({ disabledAt: new Date() }).where(eq(authAdmin.id, admin.id));
    try {
      const disabled = await adminEventsRequest();
      expect(disabled.status).toBe(403);
    } finally {
      await db.update(authAdmin).set({ disabledAt: null }).where(eq(authAdmin.id, admin.id));
    }

    const untrustedOrigin = await adminEventsRequest(adminCookies[0], 'https://untrusted.example');
    expect(untrustedOrigin.status).toBe(403);

    const enabled = await adminEventsRequest(
      adminCookies[0],
      env.cmsOrigin || 'http://localhost:3000'
    );
    expect(enabled.status).toBe(200);
    expect(enabled.headers.get('content-type')).toContain('text/event-stream');
    expect(enabled.headers.get('access-control-allow-credentials')).toBe('true');
    await enabled.body?.cancel();
  });

  it('delivers only committed resource IDs across API processes and Admin connections', async () => {
    if (!databaseReady) return;

    const childSource = [
      "import { app } from './src/app.ts';",
      "import { ensureAdminUpdateListener } from './src/modules/admin/admin-update.delivery.ts';",
      'await ensureAdminUpdateListener();',
      "const server = app.listen({ hostname: '127.0.0.1', port: 0 });",
      "console.log('READY:' + server.server?.port);",
    ].join('\n');
    const child = Bun.spawn(['bun', '-e', childSource], {
      cwd: process.cwd(),
      env: process.env,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const childOutput = child.stdout.getReader();
    let childReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let localReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const ready = await readProcessOutputLine(childOutput);
      const port = Number(ready.match(/READY:(\d+)/)?.[1]);
      if (!Number.isInteger(port) || port < 1)
        throw new Error(`API process did not start: ${ready}`);

      const remoteResponse = await fetch(`http://127.0.0.1:${port}/api/v1/admin/events`, {
        headers: { cookie: adminCookies[1]!, origin: env.cmsOrigin || 'http://localhost:3000' },
      });
      const localResponse = await adminEventsRequest(adminCookies[0]);
      expect(remoteResponse.status).toBe(200);
      expect(localResponse.status).toBe(200);
      childReader = remoteResponse.body!.getReader();
      localReader = localResponse.body!.getReader();
      const connectedFrames = await Promise.all([readText(childReader), readText(localReader)]);
      for (const frame of connectedFrames) expect(frame).toContain(': connected');

      const rolledBackId = crypto.randomUUID();
      await expect(
        db.transaction(async (transaction) => {
          await notifyAdminResourceUpdated(transaction, 'CONDUCT_REPORT', rolledBackId);
          throw new Error('force transaction rollback');
        })
      ).rejects.toThrow('force transaction rollback');

      const subjectId = crypto.randomUUID();
      const topUpId = crypto.randomUUID();
      await db.transaction(async (transaction) => {
        await notifyAdminResourceUpdated(transaction, 'CONDUCT_REPORT', subjectId);
        await notifyAdminResourceUpdated(transaction, 'TOP_UP', topUpId);
      });

      const readCommittedEvents = async (reader: ReadableStreamDefaultReader<Uint8Array>) => [
        await readEventFor(reader, 'CONDUCT_REPORT', subjectId),
        await readEventFor(reader, 'TOP_UP', topUpId),
      ];
      const [childEvents, localEvents] = await Promise.all([
        readCommittedEvents(childReader),
        readCommittedEvents(localReader),
      ]);
      const reportEvents = [childEvents[0], localEvents[0]];
      const topUpEvents = [childEvents[1], localEvents[1]];
      for (const event of reportEvents) {
        expect(event).toEqual({
          type: 'RESOURCE_UPDATED',
          subjectType: 'CONDUCT_REPORT',
          subjectId,
        });
        expect(JSON.stringify(event)).not.toContain(rolledBackId);
        expect(Object.keys(event).sort()).toEqual(['subjectId', 'subjectType', 'type']);
        expect(parseAdminUpdateNotification(JSON.stringify(event))).toEqual({
          type: 'RESOURCE_UPDATED',
          subjectType: 'CONDUCT_REPORT',
          subjectId,
        });
        expect(
          parseAdminUpdateNotification(JSON.stringify({ ...event, relatedSubjects: [] }))
        ).toBeUndefined();
      }
      for (const event of topUpEvents) {
        expect(event).toEqual({
          type: 'RESOURCE_UPDATED',
          subjectType: 'TOP_UP',
          subjectId: topUpId,
        });
        expect(Object.keys(event).sort()).toEqual(['subjectId', 'subjectType', 'type']);
        expect(parseAdminUpdateNotification(JSON.stringify(event))).toEqual({
          type: 'RESOURCE_UPDATED',
          subjectType: 'TOP_UP',
          subjectId: topUpId,
        });
      }
      const expectNoMoreEvents = async (reader: ReadableStreamDefaultReader<Uint8Array>) => {
        await expectNoEventFor(reader, 'CONDUCT_REPORT', subjectId);
        await expectNoEventFor(reader, 'TOP_UP', topUpId);
      };
      await Promise.all([expectNoMoreEvents(childReader), expectNoMoreEvents(localReader)]);
    } finally {
      await Promise.all([childReader?.cancel(), localReader?.cancel()]);
      child.kill();
      await child.exited;
      await childOutput.cancel();
    }
  });

  it('delivers separate MEMBER, Wallet, and Top-up invalidations for Admin and worker changes', async () => {
    if (!databaseReady) return;

    await ensureInitialMoneyPolicy();
    const userId = crypto.randomUUID();
    await db.insert(authUser).values({
      id: userId,
      email: `admin-update-member-${userId}@ku.th`,
      firstName: 'Update',
      lastName: 'Member',
    });
    const wallet = await ensureWallet(userId);
    const { topUp, providerEvent } = await createPendingTopUp(userId);

    const rollbackResponse = await adminEventsRequest(adminCookies[0]);
    expect(rollbackResponse.status).toBe(200);
    const rollbackReader = rollbackResponse.body!.getReader();
    try {
      expect(await readText(rollbackReader)).toContain(': connected');

      await expect(
        db.transaction(async (transaction) => {
          await transaction
            .update(walletWallet)
            .set({ updatedAt: new Date() })
            .where(eq(walletWallet.id, wallet.id));
          throw new Error('force Wallet update rollback');
        })
      ).rejects.toThrow('force Wallet update rollback');
      await expect(readEvent(rollbackReader, 50)).rejects.toThrow(
        'Timed out waiting for Admin SSE data.'
      );
    } finally {
      await rollbackReader.cancel();
    }

    const response = await adminEventsRequest(adminCookies[0]);
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    try {
      expect(await readText(reader)).toContain(': connected');

      const adminChange = await app.handle(
        new Request(`http://localhost/api/v1/admin/wallets/${wallet.id}/status`, {
          method: 'POST',
          headers: {
            cookie: adminCookies[0]!,
            'content-type': 'application/json',
            'idempotency-key': `admin-update-freeze-${crypto.randomUUID()}`,
          },
          body: JSON.stringify({ toStatus: 'FROZEN', reason: 'SSE integration test' }),
        })
      );
      expect(adminChange.status).toBe(200);

      const adminEvents = await readEventsUntil(reader, [
        (event) => event.subjectType === 'WALLET' && event.subjectId === wallet.id,
        (event) => event.subjectType === 'MEMBER' && event.subjectId === userId,
        (event) => event.subjectType === 'ADMIN_ACTIVITY_LOG',
      ]);
      expect(adminEvents).toHaveLength(3);
      expect(
        adminEvents.filter(
          (event) => event.subjectType === 'WALLET' && event.subjectId === wallet.id
        )
      ).toHaveLength(1);
      expect(
        adminEvents.filter((event) => event.subjectType === 'MEMBER' && event.subjectId === userId)
      ).toHaveLength(1);
      expect(
        adminEvents.filter((event) => event.subjectType === 'ADMIN_ACTIVITY_LOG')
      ).toHaveLength(1);
      expect(adminEvents).toContainEqual({
        type: 'RESOURCE_UPDATED',
        subjectType: 'WALLET',
        subjectId: wallet.id,
      });
      expect(adminEvents).toContainEqual({
        type: 'RESOURCE_UPDATED',
        subjectType: 'MEMBER',
        subjectId: userId,
      });

      const processed = await processTopUpProviderEvent(providerEvent.id);
      expect(processed.processingStatus).toBe('PROCESSED');

      const workerEvents = await readEventsUntil(reader, [
        (event) => event.subjectType === 'WALLET' && event.subjectId === wallet.id,
        (event) => event.subjectType === 'TOP_UP' && event.subjectId === topUp.id,
        (event) => event.subjectType === 'MEMBER' && event.subjectId === userId,
      ]);
      expect(workerEvents).toHaveLength(3);
      expect(
        workerEvents.filter(
          (event) => event.subjectType === 'WALLET' && event.subjectId === wallet.id
        )
      ).toHaveLength(1);
      expect(
        workerEvents.filter(
          (event) => event.subjectType === 'TOP_UP' && event.subjectId === topUp.id
        )
      ).toHaveLength(1);
      expect(
        workerEvents.filter((event) => event.subjectType === 'MEMBER' && event.subjectId === userId)
      ).toHaveLength(1);
      expect(workerEvents).toContainEqual({
        type: 'RESOURCE_UPDATED',
        subjectType: 'WALLET',
        subjectId: wallet.id,
      });
      expect(workerEvents).toContainEqual({
        type: 'RESOURCE_UPDATED',
        subjectType: 'TOP_UP',
        subjectId: topUp.id,
      });
      expect(workerEvents).toContainEqual({
        type: 'RESOURCE_UPDATED',
        subjectType: 'MEMBER',
        subjectId: userId,
      });
      await expect(readEvent(reader, 50)).rejects.toThrow('Timed out waiting for Admin SSE data.');
      for (const event of [...adminEvents, ...workerEvents]) {
        expect(JSON.stringify(event)).not.toContain('admin-update-test-qr');
        expect(JSON.stringify(event)).not.toContain('providerStatus');
        expect(Object.keys(event).sort()).toEqual(['subjectId', 'subjectType', 'type']);
      }
    } finally {
      await reader.cancel();
    }
  });

  it('delivers a safe Payout invalidation for a Member request', async () => {
    if (!databaseReady) return;

    await ensureInitialMoneyPolicy();
    const userId = crypto.randomUUID();
    await db.insert(authUser).values({
      id: userId,
      email: `admin-update-payout-member-${userId}@ku.th`,
      firstName: 'Update',
      lastName: 'Member',
    });
    const wallet = await ensureWallet(userId);
    const quote = await preparePendingPayoutQuote(userId);

    const response = await adminEventsRequest(adminCookies[0]);
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    try {
      expect(await readText(reader)).toContain(': connected');

      const payout = await initiatePayout({
        principalUserId: userId,
        quoteId: quote.id,
        idempotency: { key: `admin-update-payout-${crypto.randomUUID()}` },
      });
      const events = await readEventsUntil(reader, [
        (event) => event.subjectType === 'PAYOUT' && event.subjectId === payout.id,
        (event) => event.subjectType === 'WALLET' && event.subjectId === wallet.id,
        (event) => event.subjectType === 'MEMBER' && event.subjectId === userId,
      ]);

      expect(events).toHaveLength(3);
      expect(
        events.filter((event) => event.subjectType === 'PAYOUT' && event.subjectId === payout.id)
      ).toHaveLength(1);
      expect(
        events.filter((event) => event.subjectType === 'WALLET' && event.subjectId === wallet.id)
      ).toHaveLength(1);
      expect(
        events.filter((event) => event.subjectType === 'MEMBER' && event.subjectId === userId)
      ).toHaveLength(1);
      expect(events).toContainEqual({
        type: 'RESOURCE_UPDATED',
        subjectType: 'PAYOUT',
        subjectId: payout.id,
      });
      expect(events).toContainEqual({
        type: 'RESOURCE_UPDATED',
        subjectType: 'WALLET',
        subjectId: wallet.id,
      });
      expect(events).toContainEqual({
        type: 'RESOURCE_UPDATED',
        subjectType: 'MEMBER',
        subjectId: userId,
      });
      await expect(readEvent(reader, 50)).rejects.toThrow('Timed out waiting for Admin SSE data.');
      for (const event of events) {
        expect(Object.keys(event).sort()).toEqual(['subjectId', 'subjectType', 'type']);
      }
    } finally {
      await reader.cancel();
    }
  });

  it('closes open streams when the database listener restarts so clients can reconnect', async () => {
    if (!databaseReady) return;

    const response = await adminEventsRequest(adminCookies[0]);
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    expect(await readText(reader)).toContain(': connected');

    await stopAdminUpdateListener();
    expect((await reader.read()).done).toBe(true);
    await reader.cancel();

    const reconnected = await adminEventsRequest(adminCookies[0]);
    expect(reconnected.status).toBe(200);
    const reconnectReader = reconnected.body!.getReader();
    try {
      expect(await readText(reconnectReader)).toContain(': connected');
    } finally {
      await reconnectReader.cancel();
    }
  });

  it('cleans listener callbacks after a PostgreSQL disconnect and repeated restarts', async () => {
    if (!databaseReady) return;

    const response = await adminEventsRequest(adminCookies[0]);
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    try {
      expect(await readText(reader)).toContain(': connected');
      const streamClose = expectStreamToClose(reader);

      const [listener] = await sql<{ pid: number }[]>`
        select pid
        from pg_stat_activity
        where datname = current_database()
          and pid <> pg_backend_pid()
          and application_name = ${adminUpdateListenerApplicationName}
          and state = 'idle'
          and query = 'listen "kuquest_admin_updates"'
        limit 1
      `;
      if (!listener) throw new Error('Admin update PostgreSQL listener is missing.');

      const [{ terminated }] = await sql<{ terminated: boolean }[]>`
        select pg_terminate_backend(${listener.pid}) as terminated
      `;
      expect(terminated).toBe(true);
      await streamClose;

      const reconnected = await adminEventsRequest(adminCookies[0]);
      expect(reconnected.status).toBe(200);
      const reconnectReader = reconnected.body!.getReader();
      try {
        expect(await readText(reconnectReader)).toContain(': connected');
        await stopAdminUpdateListener();
        const closed = await readWithTimeout(
          reconnectReader,
          'Timed out waiting for restarted Admin SSE stream to close.',
          1_000
        );
        expect(closed.done).toBe(true);
      } finally {
        await reconnectReader.cancel();
      }

      const restarted = await adminEventsRequest(adminCookies[0]);
      expect(restarted.status).toBe(200);
      const restartedReader = restarted.body!.getReader();
      try {
        expect(await readText(restartedReader)).toContain(': connected');
        const subjectId = crypto.randomUUID();
        await db.transaction((transaction) =>
          notifyAdminResourceUpdated(transaction, 'CONDUCT_REPORT', subjectId)
        );
        expect(await readEventFor(restartedReader, 'CONDUCT_REPORT', subjectId)).toEqual({
          type: 'RESOURCE_UPDATED',
          subjectType: 'CONDUCT_REPORT',
          subjectId,
        });
        await expectNoEventFor(restartedReader, 'CONDUCT_REPORT', subjectId);

        await stopAdminUpdateListener();
        const closed = await readWithTimeout(
          restartedReader,
          'Timed out waiting for restarted Admin SSE stream to close.',
          1_000
        );
        expect(closed.done).toBe(true);
      } finally {
        await restartedReader.cancel();
      }

      const restartedAgain = await adminEventsRequest(adminCookies[0]);
      expect(restartedAgain.status).toBe(200);
      const restartedAgainReader = restartedAgain.body!.getReader();
      try {
        expect(await readText(restartedAgainReader)).toContain(': connected');
        const subjectId = crypto.randomUUID();
        await db.transaction((transaction) =>
          notifyAdminResourceUpdated(transaction, 'CONDUCT_REPORT', subjectId)
        );
        expect(await readEventFor(restartedAgainReader, 'CONDUCT_REPORT', subjectId)).toEqual({
          type: 'RESOURCE_UPDATED',
          subjectType: 'CONDUCT_REPORT',
          subjectId,
        });
        await expectNoEventFor(restartedAgainReader, 'CONDUCT_REPORT', subjectId);
      } finally {
        await restartedAgainReader.cancel();
      }
    } finally {
      await reader.cancel();
    }
  });
});
