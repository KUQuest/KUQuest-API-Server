import { db } from '@/database/client';
import { adminAction } from '@/database/schema/admin.schema';
import { authAdmin } from '@/database/schema/auth.schema';

import { and, eq, isNull, sql as drizzleSql } from 'drizzle-orm';

import {
  actionRuleFor,
  AdminActionError,
  assertPositiveVersion,
  normalizeIdentifier,
  normalizeReasonCatalog,
  normalizeReasonCode,
  normalizeRequestKey,
  normalizeRequestValue,
  normalizeResourceId,
  normalizeSafeObject,
  type AdminActionSafeValue,
  type AdminActionKind,
  type AdminActionReasonCatalog,
  type AdminActionSafeObject,
} from './admin-action.policy';

export type AdminActionTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type AdminActionResult<T extends AdminActionSafeObject = AdminActionSafeObject> = {
  resourceSummary: T;
  resourceVersion: number | null;
  resourceTimestamp: Date | null;
  adminActionId: string;
};

export type AdminActionMutation<T extends AdminActionSafeObject> = {
  outcome?: never;
  resourceSummary: T;
  resourceVersion: number | null;
  resourceTimestamp?: Date | null;
};

/**
 * `prepare` must only read and lock the resource. `apply` runs after the
 * service confirms the expected version or timestamp and must perform the
 * resource change.
 */
export type AdminActionCommandPlan<T extends AdminActionSafeObject> = {
  outcome?: never;
  currentVersion?: number;
  currentTimestamp?: Date;
  apply: () => Promise<AdminActionMutation<T>>;
};

export type AdminActionCommandPreparationContext = {
  expectedVersion: number | null;
  expectedTimestamp: Date | null;
  requestHash: string;
  requestKey: string;
};

export type AdminActionCommandPreparation<T extends AdminActionSafeObject> =
  | AdminActionCommandPlan<T>
  | { outcome: 'conflict' };

export type AdminActionEvidenceContext = {
  requestHash: string;
  requestKey: string;
};

type AdminActionBaseInput = {
  adminId: string;
  action: string;
  resourceType: string;
  resourceId: string;
  requestKey: string;
  reasonCode?: string;
  request?: unknown;
  metadata?: unknown;
};

export type AdminActionCommandRevision =
  | { expectedVersion: number; expectedTimestamp?: never }
  | { expectedVersion?: never; expectedTimestamp: Date };

export type AdminActionCommandInput<T extends AdminActionSafeObject> =
  AdminActionBaseInput &
  AdminActionCommandRevision & {
    prepare: (
      transaction: AdminActionTransaction,
      context: AdminActionCommandPreparationContext,
    ) => Promise<AdminActionCommandPreparation<T>>;
  };

/**
 * `read` must authorize the case-scoped read and return only safe summary data.
 * It must not mutate or return message/evidence content.
 */
export type AdminActionEvidenceAccessInput<T extends AdminActionSafeObject> = AdminActionBaseInput & {
  read: (
    transaction: AdminActionTransaction,
    context: AdminActionEvidenceContext,
  ) => Promise<AdminActionMutation<T>>;
};

export type AdminActionService = {
  executeCommand: <T extends AdminActionSafeObject>(
    input: AdminActionCommandInput<T>,
  ) => Promise<AdminActionResult<T>>;
  executeCommandInTransaction: <T extends AdminActionSafeObject>(
    transaction: AdminActionTransaction,
    input: AdminActionCommandInput<T>,
  ) => Promise<AdminActionResult<T>>;
  recordEvidenceAccess: <T extends AdminActionSafeObject>(
    input: AdminActionEvidenceAccessInput<T>,
  ) => Promise<AdminActionResult<T>>;
  recordEvidenceAccessInTransaction: <T extends AdminActionSafeObject>(
    transaction: AdminActionTransaction,
    input: AdminActionEvidenceAccessInput<T>,
  ) => Promise<AdminActionResult<T>>;
};

type NormalizedActionInput = {
  adminId: string;
  action: string;
  resourceType: string;
  resourceId: string;
  requestKey: string;
  reasonCode: string | undefined;
  expectedVersion: number | null;
  expectedTimestamp: Date | null;
  metadata: AdminActionSafeObject;
  request: AdminActionSafeValue | null;
  requestHash: string;
};

type StoredActionResult = {
  resourceSummary: AdminActionSafeObject;
  resourceVersion: number | null;
  resourceTimestamp: Date | null;
  adminActionId: string;
};

type InternalActionInput<T extends AdminActionSafeObject> = NormalizedActionInput & {
  kind: AdminActionKind;
  execute: (
    transaction: AdminActionTransaction,
    context: {
      requestHash: string;
      requestKey: string;
      expectedVersion: number | null;
      expectedTimestamp: Date | null;
    },
  ) => Promise<
    | { outcome: 'conflict' }
    | {
        outcome?: never;
        resourceSummary: T;
        resourceVersion: number | null;
        resourceTimestamp?: Date | null;
      }
  >;
};

const canonicalJson = (value: AdminActionSafeValue): string => {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;

  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`)
    .join(',')}}`;
};

const requestHashFor = async (value: AdminActionSafeValue): Promise<string> => {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonicalJson(value)),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
};

const advisoryLockKeyFor = (input: NormalizedActionInput): string =>
  `admin-action:${input.adminId}:${input.action}:${input.requestKey}`;

const normalizeTimestamp = (value: unknown, field: string): Date | null => {
  if (value === undefined || value === null) return null;
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new AdminActionError(
      'ADMIN_ACTION_INVALID_VERSION',
      `${field} must be a valid timestamp.`,
    );
  }
  return new Date(value.getTime());
};

const normalizeInput = async (
  catalog: AdminActionReasonCatalog,
  kind: AdminActionKind,
  input: AdminActionBaseInput & {
    expectedVersion?: number;
    expectedTimestamp?: Date;
  },
): Promise<NormalizedActionInput> => {
  const adminId = normalizeResourceId(input.adminId, 'adminId');
  const action = normalizeIdentifier(input.action, 'action');
  const resourceType = normalizeIdentifier(input.resourceType, 'resourceType');
  const resourceId = normalizeResourceId(input.resourceId);
  const requestKey = normalizeRequestKey(input.requestKey);
  const rule = actionRuleFor(catalog, action, kind);
  const reasonCode = normalizeReasonCode(rule, input.reasonCode);
  const expectedVersion = input.expectedVersion === undefined
    ? null
    : assertPositiveVersion(input.expectedVersion, 'expectedVersion');
  const expectedTimestamp = normalizeTimestamp(input.expectedTimestamp, 'expectedTimestamp');
  if (kind === 'COMMAND' && (expectedVersion === null) === (expectedTimestamp === null)) {
    throw new AdminActionError(
      'ADMIN_ACTION_INVALID_VERSION',
      'A command must provide exactly one expected resource version or timestamp.',
    );
  }
  if (kind === 'EVIDENCE_ACCESS' && (expectedVersion !== null || expectedTimestamp !== null)) {
    throw new AdminActionError(
      'ADMIN_ACTION_INVALID_VERSION',
      'Evidence access cannot include an expected resource version or timestamp.',
    );
  }
  const metadata = normalizeSafeObject(input.metadata);
  const request = normalizeRequestValue(input.request);
  const requestHash = await requestHashFor({
    adminId,
    action,
    kind,
    resourceType,
    resourceId,
    requestKey,
    reasonCatalogVersion: catalog.version,
    reasonCode: reasonCode ?? null,
    expectedVersion,
    expectedTimestamp: expectedTimestamp?.toISOString() ?? null,
    request,
    metadata,
  });

  return {
    adminId,
    action,
    resourceType,
    resourceId,
    requestKey,
    reasonCode,
    expectedVersion,
    expectedTimestamp,
    metadata,
    request,
    requestHash,
  };
};

const adminExists = async (
  transaction: AdminActionTransaction,
  adminId: string,
): Promise<boolean> => {
  const [admin] = await transaction
    .select({ id: authAdmin.id })
    .from(authAdmin)
    .where(and(
      eq(authAdmin.id, adminId),
      isNull(authAdmin.disabledAt),
    ))
    .limit(1);
  return Boolean(admin);
};

const storedResultFrom = (
  row: typeof adminAction.$inferSelect,
): StoredActionResult => ({
  resourceSummary: normalizeSafeObject(row.resultData, 'resultData'),
  resourceVersion: row.resultVersion,
  resourceTimestamp: normalizeTimestamp(row.resultTimestamp, 'resultTimestamp'),
  adminActionId: row.id,
});

const findExistingAction = async (
  transaction: AdminActionTransaction,
  input: NormalizedActionInput,
): Promise<typeof adminAction.$inferSelect | undefined> => {
  const [existing] = await transaction
    .select()
    .from(adminAction)
    .where(and(
      eq(adminAction.adminId, input.adminId),
      eq(adminAction.action, input.action),
      eq(adminAction.requestKey, input.requestKey),
    ))
    .limit(1)
    .for('update');
  return existing;
};

const replayOrValidateExisting = (
  existing: typeof adminAction.$inferSelect | undefined,
  input: NormalizedActionInput,
): StoredActionResult | undefined => {
  if (!existing) return undefined;
  if (existing.requestHash !== input.requestHash) {
    throw new AdminActionError(
      'ADMIN_ACTION_KEY_REUSED',
      'Admin Action request key was used with a different request.',
    );
  }
  // `assertResourceRevision` proved the revision when the row was written, and an
  // Admin Action is immutable, so the stored result needs no second reading.
  return storedResultFrom(existing);
};

const assertResourceRevision = (
  expectedVersion: number | null,
  expectedTimestamp: Date | null,
  resourceVersion: number | null,
  resourceTimestamp: Date | null,
): void => {
  if (resourceVersion !== null) assertPositiveVersion(resourceVersion, 'resourceVersion');
  if (resourceTimestamp !== null) normalizeTimestamp(resourceTimestamp, 'resourceTimestamp');
  if (expectedVersion !== null) {
    if (resourceVersion === null) {
      throw new AdminActionError(
        'ADMIN_ACTION_INVALID_RESULT',
        'A version-based command must return a resource version.',
      );
    }
    if (resourceVersion <= expectedVersion) {
      throw new AdminActionError(
        'ADMIN_ACTION_INVALID_RESULT',
        'A successful command must return a newer resource version.',
      );
    }
    return;
  }
  if (expectedTimestamp === null) return;
  if (resourceTimestamp === null) {
    throw new AdminActionError(
      'ADMIN_ACTION_INVALID_RESULT',
      'A timestamp-based command must return a resource timestamp.',
    );
  }
  if (resourceTimestamp.getTime() < expectedTimestamp.getTime()) {
    throw new AdminActionError(
      'ADMIN_ACTION_INVALID_RESULT',
      'A successful command must return a current or newer resource timestamp.',
    );
  }
};

const runAdminActionInTransaction = async <T extends AdminActionSafeObject>(
  transaction: AdminActionTransaction,
  catalog: AdminActionReasonCatalog,
  input: InternalActionInput<T>,
): Promise<StoredActionResult> => {
  await transaction.execute(
    drizzleSql`select pg_advisory_xact_lock(hashtextextended(${advisoryLockKeyFor(input)}, 0))`,
  );

  if (!(await adminExists(transaction, input.adminId))) {
    throw new AdminActionError(
      'ADMIN_ACTION_ADMIN_NOT_FOUND',
      'Enabled Admin account does not exist.',
    );
  }

  const existing = replayOrValidateExisting(
    await findExistingAction(transaction, input),
    input,
  );
  if (existing) return existing;

  const execution = await input.execute(transaction, {
    requestHash: input.requestHash,
    requestKey: input.requestKey,
    expectedVersion: input.expectedVersion,
    expectedTimestamp: input.expectedTimestamp,
  });
  if (execution.outcome === 'conflict') {
    throw new AdminActionError(
      'ADMIN_ACTION_CONFLICT',
      'Admin Action resource version or timestamp is stale.',
    );
  }

  const resourceVersion = execution.resourceVersion;
  const resourceTimestamp = normalizeTimestamp(
    execution.resourceTimestamp,
    'resourceTimestamp',
  );
  assertResourceRevision(
    input.expectedVersion,
    input.expectedTimestamp,
    resourceVersion,
    resourceTimestamp,
  );
  const resourceSummary = normalizeSafeObject(execution.resourceSummary, 'resultData');
  const [created] = await transaction
    .insert(adminAction)
    .values({
      adminId: input.adminId,
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      requestKey: input.requestKey,
      requestHash: input.requestHash,
      reasonCatalogVersion: catalog.version,
      reasonCode: input.reasonCode,
      expectedVersion: input.expectedVersion,
      expectedTimestamp: input.expectedTimestamp,
      resultVersion: resourceVersion,
      resultTimestamp: resourceTimestamp,
      metadata: input.metadata,
      resultData: resourceSummary,
      createdAt: drizzleSql`clock_timestamp()`,
    })
    .returning({ id: adminAction.id });
  if (!created) {
    throw new AdminActionError(
      'ADMIN_ACTION_WRITE_FAILED',
      'Admin Action could not be recorded.',
    );
  }

  return {
    resourceSummary,
    resourceVersion,
    resourceTimestamp,
    adminActionId: created.id,
  };
};

const toCommandResult = <T extends AdminActionSafeObject>(
  result: StoredActionResult,
): AdminActionResult<T> => {
  if (result.resourceVersion === null && result.resourceTimestamp === null) {
    throw new AdminActionError(
      'ADMIN_ACTION_INVALID_RESULT',
      'A command Admin Action is missing its resource revision.',
    );
  }
  return {
    resourceSummary: result.resourceSummary as T,
    resourceVersion: result.resourceVersion,
    resourceTimestamp: result.resourceTimestamp,
    adminActionId: result.adminActionId,
  };
};

const toEvidenceResult = <T extends AdminActionSafeObject>(
  result: StoredActionResult,
): AdminActionResult<T> => ({
  resourceSummary: result.resourceSummary as T,
  resourceVersion: result.resourceVersion,
  resourceTimestamp: result.resourceTimestamp,
  adminActionId: result.adminActionId,
});

/**
 * Create the shared Admin Action writer from a code-owned reason catalog.
 * The catalog is not request data and must not come from an Admin client.
 */
export const createAdminActionService = (
  rawCatalog: AdminActionReasonCatalog,
): AdminActionService => {
  const catalog = normalizeReasonCatalog(rawCatalog);

  const executeCommandInTransaction = async <T extends AdminActionSafeObject>(
    transaction: AdminActionTransaction,
    input: AdminActionCommandInput<T>,
  ): Promise<AdminActionResult<T>> => {
    const normalized = await normalizeInput(catalog, 'COMMAND', input);
    const result = await runAdminActionInTransaction(transaction, catalog, {
      ...normalized,
      kind: 'COMMAND',
      execute: async (currentTransaction, context) => {
        const plan = await input.prepare(currentTransaction, {
          expectedVersion: normalized.expectedVersion,
          expectedTimestamp: normalized.expectedTimestamp,
          requestHash: context.requestHash,
          requestKey: context.requestKey,
        });
        if (plan.outcome === 'conflict') return plan;
        const currentVersion = plan.currentVersion === undefined
          ? null
          : assertPositiveVersion(plan.currentVersion, 'currentVersion');
        const currentTimestamp = normalizeTimestamp(plan.currentTimestamp, 'currentTimestamp');
        if (
          (normalized.expectedVersion !== null && currentVersion !== normalized.expectedVersion) ||
          (normalized.expectedTimestamp !== null && (
            currentTimestamp === null ||
            currentTimestamp.getTime() !== normalized.expectedTimestamp.getTime()
          ))
        ) {
          return { outcome: 'conflict' };
        }
        return plan.apply();
      },
    });
    return toCommandResult<T>(result);
  };

  const executeCommand = async <T extends AdminActionSafeObject>(
    input: AdminActionCommandInput<T>,
  ): Promise<AdminActionResult<T>> =>
    db.transaction((transaction) => executeCommandInTransaction(transaction, input));

  const recordEvidenceAccessInTransaction = async <T extends AdminActionSafeObject>(
    transaction: AdminActionTransaction,
    input: AdminActionEvidenceAccessInput<T>,
  ): Promise<AdminActionResult<T>> => {
    const normalized = await normalizeInput(catalog, 'EVIDENCE_ACCESS', input);
    const result = await runAdminActionInTransaction(transaction, catalog, {
      ...normalized,
      kind: 'EVIDENCE_ACCESS',
      execute: (currentTransaction, context) => input.read(currentTransaction, {
        requestHash: context.requestHash,
        requestKey: context.requestKey,
      }),
    });
    return toEvidenceResult<T>(result);
  };

  const recordEvidenceAccess = async <T extends AdminActionSafeObject>(
    input: AdminActionEvidenceAccessInput<T>,
  ): Promise<AdminActionResult<T>> =>
    db.transaction((transaction) => recordEvidenceAccessInTransaction(transaction, input));

  return {
    executeCommand,
    executeCommandInTransaction,
    recordEvidenceAccess,
    recordEvidenceAccessInTransaction,
  };
};

export type { AdminActionErrorCode } from './admin-action.policy';
export { AdminActionError } from './admin-action.policy';
