import { auditRecord } from '@/database/schema/audit.schema';

import type { QuestTransaction } from '@/modules/quest/quest-work-chat.port';

export type AuditActor =
  | { actorType: 'MEMBER'; actorUserId: string }
  | { actorType: 'ADMIN'; actorAdminId: string }
  | { actorType: 'SYSTEM' };

export type AuditInput = AuditActor & {
  action: string;
  resourceType: string;
  resourceId: string;
  oldValue?: Record<string, unknown> | null;
  newValue?: Record<string, unknown> | null;
  reason?: string | null;
  createdAt: Date;
};

export const recordAudit = async (transaction: QuestTransaction, input: AuditInput) => {
  await transaction.insert(auditRecord).values({
    actorType: input.actorType,
    actorUserId: 'actorUserId' in input ? input.actorUserId : null,
    actorAdminId: 'actorAdminId' in input ? input.actorAdminId : null,
    action: input.action,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    oldValue: input.oldValue ?? null,
    newValue: input.newValue ?? null,
    reason: input.reason ?? null,
    createdAt: input.createdAt,
  });
};
