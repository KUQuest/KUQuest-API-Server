import { db, sql } from '@/database/client';
import { adminAction } from '@/database/schema/admin.schema';
import { authAdmin, authUser } from '@/database/schema/auth.schema';
import {
  createAdminActionService,
  type AdminActionCommandInput,
  type AdminActionCommandRevision,
  type AdminActionErrorCode,
  type AdminActionSafeObject,
} from '@/modules/admin';

import { beforeAll, describe, expect, it } from 'bun:test';
import { and, eq } from 'drizzle-orm';

const adminActionService = createAdminActionService({
  version: 1,
  actions: {
    MEMBER_FREEZE: {
      kind: 'COMMAND',
      requiresReason: true,
      allowedReasonCodes: ['POLICY_REVIEW', 'SAFETY_REVIEW'],
    },
    EVIDENCE_READ: {
      kind: 'EVIDENCE_ACCESS',
      requiresReason: false,
      allowedReasonCodes: [],
    },
  },
});

const createAdmin = async () => {
  const id = crypto.randomUUID();
  await db.insert(authAdmin).values({
    id,
    email: `${id}@example.com`,
    firstName: 'Action',
    lastName: 'Admin',
  });
  return id;
};

const createMember = async () => {
  const id = crypto.randomUUID();
  await db.insert(authUser).values({
    id,
    email: `${id}@ku.th`,
    firstName: 'Action',
    lastName: 'Member',
  });
  return id;
};

type MemberCommandOptions = {
  adminId: string;
  memberId: string;
  requestKey?: string;
  expectedVersion?: number;
  expectedTimestamp?: Date;
  reasonCode?: string;
  request?: unknown;
  metadata?: unknown;
  summary?: AdminActionSafeObject;
  onApply?: () => void;
  failAfterUpdate?: boolean;
};

const memberCommand = (
  options: MemberCommandOptions,
): AdminActionCommandInput<AdminActionSafeObject> => {
  const revision: AdminActionCommandRevision = options.expectedTimestamp
    ? { expectedTimestamp: options.expectedTimestamp }
    : { expectedVersion: options.expectedVersion ?? 1 };

  return {
    adminId: options.adminId,
    action: 'MEMBER_FREEZE',
    resourceType: 'AUTH_USER',
    resourceId: options.memberId,
    requestKey: options.requestKey ?? crypto.randomUUID(),
    ...revision,
    reasonCode: 'reasonCode' in options ? options.reasonCode : 'POLICY_REVIEW',
    request: options.request ?? { targetStatus: 'FROZEN' },
    metadata: options.metadata ?? {
      previousStatus: 'ACTIVE',
      nextStatus: 'FROZEN',
    },
    prepare: async (transaction, context) => {
      const [member] = await transaction
        .select({
          id: authUser.id,
          version: authUser.version,
          updatedAt: authUser.updatedAt,
        })
        .from(authUser)
        .where(eq(authUser.id, options.memberId))
        .for('update');
      if (!member) throw new Error('Test Member was not found.');

      return {
        currentVersion: member.version,
        currentTimestamp: member.updatedAt,
        apply: async () => {
          const [updated] = await transaction
            .update(authUser)
            .set({ version: member.version + 1, updatedAt: new Date() })
            .where(and(eq(authUser.id, member.id), eq(authUser.version, member.version)))
            .returning({
              id: authUser.id,
              version: authUser.version,
              updatedAt: authUser.updatedAt,
            });
          if (!updated) throw new Error('Test Member update failed.');
          options.onApply?.();
          if (options.failAfterUpdate) throw new Error('Test command failed after resource update.');

          return {
            resourceVersion: context.expectedTimestamp === null ? updated.version : null,
            resourceTimestamp: context.expectedTimestamp === null ? null : updated.updatedAt,
            resourceSummary: options.summary ?? {
              id: updated.id,
              version: updated.version,
              status: 'FROZEN',
            },
          };
        },
      };
    },
  };
};

// `expect(...).rejects` hangs on a rejected database promise, so both helpers below
// read the rejection themselves. Drizzle wraps a driver failure, so a trigger's own
// message sits on the cause rather than the thrown error.
const rejectionMessage = async (operation: Promise<unknown>): Promise<string> => {
  try {
    await operation;
  } catch (error) {
    const messages: string[] = [];
    for (let current: unknown = error; current instanceof Error; current = current.cause) {
      messages.push(current.message);
    }
    return messages.join(' | ');
  }
  return '';
};

const expectAdminActionError = async (
  operation: Promise<unknown>,
  code: AdminActionErrorCode,
) => {
  let actual: string | undefined;
  try {
    await operation;
  } catch (error) {
    actual = (error as { code?: string }).code;
  }
  expect(actual).toBe(code);
};

beforeAll(async () => {
  try {
    await sql`select 1`;
  } catch (cause) {
    throw new Error(
      'These tests need PostgreSQL. Start it with `docker compose up -d postgres`, then apply the schema with `bun run db:migrate`.',
      { cause },
    );
  }
});

describe('Admin Action service', () => {
  it('records a safe command result and audit metadata', async () => {
    const adminId = await createAdmin();
    const memberId = await createMember();
    const requestKey = crypto.randomUUID();

    const result = await adminActionService.executeCommand(memberCommand({
      adminId,
      memberId,
      requestKey,
    }));

    expect(result).toMatchObject({
      resourceSummary: { id: memberId, version: 2, status: 'FROZEN' },
      resourceVersion: 2,
    });
    expect(result.adminActionId).toMatch(/^[0-9a-f-]{36}$/);

    const [record] = await db
      .select()
      .from(adminAction)
      .where(eq(adminAction.id, result.adminActionId));
    expect(record).toMatchObject({
      id: result.adminActionId,
      adminId,
      action: 'MEMBER_FREEZE',
      resourceType: 'AUTH_USER',
      resourceId: memberId,
      requestKey,
      reasonCatalogVersion: 1,
      reasonCode: 'POLICY_REVIEW',
      expectedVersion: 1,
      resultVersion: 2,
      metadata: { previousStatus: 'ACTIVE', nextStatus: 'FROZEN' },
      resultData: { id: memberId, version: 2, status: 'FROZEN' },
    });
    expect(record?.createdAt).toBeInstanceOf(Date);
  });

  it('accepts a timestamp revision and returns the updated timestamp', async () => {
    const adminId = await createAdmin();
    const memberId = await createMember();
    const requestKey = crypto.randomUUID();
    const [current] = await db
      .select({ updatedAt: authUser.updatedAt })
      .from(authUser)
      .where(eq(authUser.id, memberId));
    if (!current) throw new Error('Test Member timestamp was not found.');
    const expectedTimestamp = current.updatedAt;

    const result = await adminActionService.executeCommand(memberCommand({
      adminId,
      memberId,
      requestKey,
      expectedTimestamp,
    }));

    expect(result.resourceVersion).toBeNull();
    expect(result.resourceTimestamp).toBeInstanceOf(Date);
    const [record] = await db
      .select()
      .from(adminAction)
      .where(eq(adminAction.id, result.adminActionId));
    expect(record).toMatchObject({
      expectedVersion: null,
      resultVersion: null,
      expectedTimestamp,
    });
    expect(record?.resultTimestamp).toBeInstanceOf(Date);
  });

  it('replays the original result and rejects a changed request key', async () => {
    const adminId = await createAdmin();
    const memberId = await createMember();
    const requestKey = crypto.randomUUID();
    let applyCount = 0;
    const input = memberCommand({
      adminId,
      memberId,
      requestKey,
      onApply: () => {
        applyCount += 1;
      },
    });

    const first = await adminActionService.executeCommand(input);
    const replay = await adminActionService.executeCommand(input);

    expect(replay).toEqual(first);
    expect(applyCount).toBe(1);

    await expectAdminActionError(
      adminActionService.executeCommand(memberCommand({
        adminId,
        memberId,
        requestKey,
        request: { targetStatus: 'SUSPENDED' },
      })),
      'ADMIN_ACTION_KEY_REUSED',
    );
    expect(applyCount).toBe(1);
  });

  it('serializes concurrent retries for one request key', async () => {
    const adminId = await createAdmin();
    const memberId = await createMember();
    const requestKey = crypto.randomUUID();
    let applyCount = 0;
    const input = memberCommand({
      adminId,
      memberId,
      requestKey,
      onApply: () => {
        applyCount += 1;
      },
    });

    const results = await Promise.all([
      adminActionService.executeCommand(input),
      adminActionService.executeCommand(input),
    ]);

    expect(results[0]).toEqual(results[1]);
    expect(applyCount).toBe(1);
    expect(await db.select().from(adminAction).where(eq(adminAction.requestKey, requestKey))).toHaveLength(1);
  });

  it('rejects a stale command before applying or auditing it', async () => {
    const adminId = await createAdmin();
    const memberId = await createMember();
    const requestKey = crypto.randomUUID();
    await db
      .update(authUser)
      .set({ version: 2, updatedAt: new Date() })
      .where(eq(authUser.id, memberId));
    let applyCount = 0;

    await expectAdminActionError(
      adminActionService.executeCommand(memberCommand({
        adminId,
        memberId,
        requestKey,
        expectedVersion: 1,
        onApply: () => {
          applyCount += 1;
        },
      })),
      'ADMIN_ACTION_CONFLICT',
    );

    const [member] = await db
      .select({ version: authUser.version })
      .from(authUser)
      .where(eq(authUser.id, memberId));
    expect(member?.version).toBe(2);
    expect(applyCount).toBe(0);
    expect(await db.select().from(adminAction).where(eq(adminAction.requestKey, requestKey))).toHaveLength(0);
  });

  it('rolls back the resource update and Admin Action together', async () => {
    const adminId = await createAdmin();
    const memberId = await createMember();
    const requestKey = crypto.randomUUID();

    await expect(
      adminActionService.executeCommand(memberCommand({
        adminId,
        memberId,
        requestKey,
        failAfterUpdate: true,
      })),
    ).rejects.toThrow('Test command failed after resource update.');

    const [member] = await db
      .select({ version: authUser.version })
      .from(authUser)
      .where(eq(authUser.id, memberId));
    expect(member?.version).toBe(1);
    expect(await db.select().from(adminAction).where(eq(adminAction.requestKey, requestKey))).toHaveLength(0);
  });

  it('honors the caller transaction boundary on rollback', async () => {
    const adminId = await createAdmin();
    const memberId = await createMember();
    const requestKey = crypto.randomUUID();
    const input = memberCommand({ adminId, memberId, requestKey });

    await expect(
      db.transaction(async (transaction) => {
        await adminActionService.executeCommandInTransaction(transaction, input);
        throw new Error('Caller transaction rolled back.');
      }),
    ).rejects.toThrow('Caller transaction rolled back.');

    const [member] = await db
      .select({ version: authUser.version })
      .from(authUser)
      .where(eq(authUser.id, memberId));
    expect(member?.version).toBe(1);
    expect(await db.select().from(adminAction).where(eq(adminAction.requestKey, requestKey))).toHaveLength(0);
  });

  it('rejects free-form reasons and unsafe metadata before writing', async () => {
    const adminId = await createAdmin();
    const memberId = await createMember();

    await expectAdminActionError(
      adminActionService.executeCommand(memberCommand({
        adminId,
        memberId,
        reasonCode: 'free form reason',
      })),
      'ADMIN_ACTION_INVALID_REASON_CODE',
    );
    await expectAdminActionError(
      adminActionService.executeCommand(memberCommand({
        adminId,
        memberId,
        metadata: { messageText: 'private message' },
      })),
      'ADMIN_ACTION_UNSAFE_METADATA',
    );
    await expectAdminActionError(
      adminActionService.executeCommand(memberCommand({
        adminId,
        memberId,
        summary: { evidence: 'raw evidence' },
      })),
      'ADMIN_ACTION_UNSAFE_METADATA',
    );

    expect(await db.select().from(adminAction).where(eq(adminAction.resourceId, memberId))).toHaveLength(0);
  });

  it('rejects a missing reason and a Student identity as the Admin actor', async () => {
    const adminId = await createAdmin();
    const memberId = await createMember();

    await expectAdminActionError(
      adminActionService.executeCommand(memberCommand({
        adminId,
        memberId,
        reasonCode: undefined,
      })),
      'ADMIN_ACTION_REASON_REQUIRED',
    );
    await expectAdminActionError(
      adminActionService.executeCommand(memberCommand({
        adminId: memberId,
        memberId,
      })),
      'ADMIN_ACTION_ADMIN_NOT_FOUND',
    );
  });

  it('audits evidence access without storing evidence content', async () => {
    const adminId = await createAdmin();
    const requestKey = crypto.randomUUID();
    let readCount = 0;
    const input = {
      adminId,
      action: 'EVIDENCE_READ',
      resourceType: 'REPORT_CASE',
      resourceId: crypto.randomUUID(),
      requestKey,
      request: { caseView: 'summary' },
      read: async () => {
        readCount += 1;
        return {
          resourceVersion: null,
          resourceSummary: { caseId: 'case-1', outcome: 'REVIEWED' },
        };
      },
    };

    const first = await adminActionService.recordEvidenceAccess(input);
    const replay = await adminActionService.recordEvidenceAccess(input);

    expect(replay).toEqual(first);
    expect(readCount).toBe(1);
    const [record] = await db
      .select()
      .from(adminAction)
      .where(eq(adminAction.id, first.adminActionId));
    expect(record).toMatchObject({
      adminId,
      action: 'EVIDENCE_READ',
      resourceType: 'REPORT_CASE',
      requestKey,
      expectedVersion: null,
      resultVersion: null,
      reasonCode: null,
      resultData: { caseId: 'case-1', outcome: 'REVIEWED' },
    });
  });

  it('rejects updates and deletes against retained Admin Actions', async () => {
    const adminId = await createAdmin();
    const memberId = await createMember();
    const result = await adminActionService.executeCommand(memberCommand({ adminId, memberId }));

    expect(await rejectionMessage(
      db
        .update(adminAction)
        .set({ reasonCode: 'SAFETY_REVIEW' })
        .where(eq(adminAction.id, result.adminActionId))
        .execute(),
    )).toContain('Admin Action is immutable');
    expect(await rejectionMessage(
      db.delete(adminAction).where(eq(adminAction.id, result.adminActionId)).execute(),
    )).toContain('Admin Action is immutable');
  });
});
