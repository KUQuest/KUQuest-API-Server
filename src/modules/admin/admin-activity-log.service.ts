import { db } from '@/database/client';
import {
  adminAction,
  adminConductReport,
  adminDisputeCase,
  adminReportCase,
} from '@/database/schema/admin.schema';
import { authAdmin } from '@/database/schema/auth.schema';
import { paymentPayouts } from '@/database/schema/payment.schema';
import { quest } from '@/database/schema/quest.schema';
import { walletWallet } from '@/database/schema/wallet.schema';
import {
  formatConductReportDisplayId,
  formatDisputeDisplayId,
  formatPayoutDisplayId,
  formatQuestDisplayId,
  formatReportCaseDisplayId,
  formatWalletDisplayId,
} from '@/modules/admin/admin-display-id';
import { CursorInputError } from '@/shared/cursor';
import type { CursorPayload } from '@/shared/cursor';
import { readKeysetPage } from '@/shared/keyset-page';

import { and, eq, inArray } from 'drizzle-orm';

export type AdminActivityEntry = {
  id: string;
  admin: { id: string; firstName: string; lastName: string };
  action: string;
  resourceType: string;
  resourceId: string;
  resourceDisplayId?: string;
  reasonCode: string | null;
  reasonCatalogVersion: number;
  resultVersion: number | null;
  resultTimestamp: Date | null;
  createdAt: Date;
};

export type ListAdminActivityInput = {
  action?: string;
  resourceType?: string;
  resourceId?: string;
  adminId?: string;
  limit?: number;
  cursor?: CursorPayload;
  sort?: 'newest' | 'oldest';
};

export type AdminActivityPage = {
  items: AdminActivityEntry[];
  nextCursor: Omit<CursorPayload, 'v'> | null;
};

/**
 * Lists the safe columns of immutable Admin Actions. Evidence and request
 * data are intentionally not selected from the database.
 */
export const listAdminActivity = async ({
  action,
  resourceType,
  resourceId,
  adminId,
  limit = 20,
  cursor,
  sort = 'newest',
}: ListAdminActivityInput = {}): Promise<AdminActivityPage> => {
  const page = await readKeysetPage({
    anchor: { time: adminAction.createdAt, id: adminAction.id },
    cursor,
    limit,
    sort,
    where: and(
      action ? eq(adminAction.action, action) : undefined,
      resourceType ? eq(adminAction.resourceType, resourceType) : undefined,
      resourceId ? eq(adminAction.resourceId, resourceId) : undefined,
      adminId ? eq(adminAction.adminId, adminId) : undefined
    ),
    read: ({ where, orderBy, limit: probe }) =>
      db
        .select({
          id: adminAction.id,
          admin: {
            id: authAdmin.id,
            firstName: authAdmin.firstName,
            lastName: authAdmin.lastName,
          },
          action: adminAction.action,
          resourceType: adminAction.resourceType,
          resourceId: adminAction.resourceId,
          reasonCode: adminAction.reasonCode,
          reasonCatalogVersion: adminAction.reasonCatalogVersion,
          resultVersion: adminAction.resultVersion,
          resultTimestamp: adminAction.resultTimestamp,
          createdAt: adminAction.createdAt,
        })
        .from(adminAction)
        .innerJoin(authAdmin, eq(authAdmin.id, adminAction.adminId))
        .where(where)
        .orderBy(...orderBy)
        .limit(probe),
    rowCursor: (row) => ({ startTime: row.createdAt, id: row.id }),
    invalidCursor: () =>
      new CursorInputError('INVALID_CURSOR', 'cursor does not match an Admin Action'),
  });

  const idsByResourceType = new Map<string, Set<string>>();
  for (const entry of page.rows) {
    if (!/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(entry.resourceId)) continue;
    const resourceType = entry.resourceType.trim().toUpperCase();
    const ids = idsByResourceType.get(resourceType) ?? new Set<string>();
    ids.add(entry.resourceId);
    idsByResourceType.set(resourceType, ids);
  }

  const resourceDisplayIds = new Map<string, string>();
  const addResourceDisplayIds = async (
    resourceType: string,
    ids: string[],
    read: (ids: string[]) => PromiseLike<Array<{ id: string; publicSequence: number }>>,
    format: (publicSequence: number) => string
  ) => {
    if (!ids.length) return;
    const rows = await read(ids);
    for (const row of rows) {
      resourceDisplayIds.set(`${resourceType}:${row.id}`, format(row.publicSequence));
    }
  };
  const idsFor = (resourceType: string) => [...(idsByResourceType.get(resourceType) ?? [])];

  await Promise.all([
    addResourceDisplayIds(
      'QUEST',
      idsFor('QUEST'),
      (ids) =>
        db
          .select({ id: quest.id, publicSequence: quest.publicSequence })
          .from(quest)
          .where(inArray(quest.id, ids)),
      formatQuestDisplayId
    ),
    addResourceDisplayIds(
      'PAYOUT',
      idsFor('PAYOUT'),
      (ids) =>
        db
          .select({ id: paymentPayouts.id, publicSequence: paymentPayouts.publicSequence })
          .from(paymentPayouts)
          .where(inArray(paymentPayouts.id, ids)),
      formatPayoutDisplayId
    ),
    addResourceDisplayIds(
      'DISPUTE_CASE',
      idsFor('DISPUTE_CASE'),
      (ids) =>
        db
          .select({ id: adminDisputeCase.id, publicSequence: adminDisputeCase.publicSequence })
          .from(adminDisputeCase)
          .where(inArray(adminDisputeCase.id, ids)),
      formatDisputeDisplayId
    ),
    addResourceDisplayIds(
      'REPORT_CASE',
      idsFor('REPORT_CASE'),
      (ids) =>
        db
          .select({ id: adminReportCase.id, publicSequence: adminReportCase.publicSequence })
          .from(adminReportCase)
          .where(inArray(adminReportCase.id, ids)),
      formatReportCaseDisplayId
    ),
    addResourceDisplayIds(
      'CONDUCT_REPORT',
      idsFor('CONDUCT_REPORT'),
      (ids) =>
        db
          .select({ id: adminConductReport.id, publicSequence: adminConductReport.publicSequence })
          .from(adminConductReport)
          .where(inArray(adminConductReport.id, ids)),
      formatConductReportDisplayId
    ),
    addResourceDisplayIds(
      'WALLET',
      idsFor('WALLET'),
      (ids) =>
        db
          .select({ id: walletWallet.id, publicSequence: walletWallet.publicSequence })
          .from(walletWallet)
          .where(inArray(walletWallet.id, ids)),
      formatWalletDisplayId
    ),
  ]);

  return {
    items: page.rows.map((entry) => {
      const resourceDisplayId = resourceDisplayIds.get(
        `${entry.resourceType.trim().toUpperCase()}:${entry.resourceId}`
      );
      return {
        ...entry,
        ...(resourceDisplayId ? { resourceDisplayId } : {}),
      };
    }),
    nextCursor: page.nextCursor,
  };
};

export const serializeAdminActivityEntry = (entry: AdminActivityEntry) => ({
  ...entry,
  resultTimestamp: entry.resultTimestamp ? entry.resultTimestamp.toISOString() : null,
  createdAt: entry.createdAt.toISOString(),
});
