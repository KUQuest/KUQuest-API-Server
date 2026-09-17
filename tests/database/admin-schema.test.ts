import {
  adminConductReport,
  conductReportReason,
  conductReportReasons,
  conductReportStatus,
  conductReportStatuses,
} from '@/database/schema/admin.schema';

import { describe, expect, it } from 'bun:test';
import { getTableColumns } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';

describe('Admin database schema', () => {
  it('uses the canonical Conduct Report reasons and statuses', () => {
    expect(conductReportReasons).toEqual([
      conductReportReason.abandoned,
      conductReportReason.outOfScope,
      conductReportReason.noShow,
    ]);
    expect(conductReportStatuses).toEqual([
      conductReportStatus.pending,
      conductReportStatus.upheld,
      conductReportStatus.dismissed,
    ]);
  });

  it('stores a retained Conduct Report with Quest record and decision references', () => {
    const columns = getTableColumns(adminConductReport);
    const config = getTableConfig(adminConductReport);

    expect(Object.keys(columns)).toEqual([
      'id',
      'questId',
      'filerUserId',
      'reportedMemberId',
      'assignmentId',
      'reason',
      'detail',
      'status',
      'version',
      'decisionReason',
      'resolvedByAdminId',
      'resolvedAt',
      'createdAt',
      'updatedAt',
    ]);
    expect(columns.questId.name).toBe('quest_id');
    expect(columns.filerUserId.name).toBe('filer_user_id');
    expect(columns.reportedMemberId.name).toBe('reported_member_id');
    expect(columns.assignmentId.name).toBe('assignment_id');
    expect(columns.decisionReason.name).toBe('decision_reason');
    expect(
      config.uniqueConstraints.map((constraint) => constraint.columns.map((column) => column.name))
    ).toContainEqual(['quest_id', 'reported_member_id']);
    const assignmentContextForeignKey = config.foreignKeys.find(
      (foreignKey) => foreignKey.reference().name === 'admin_conduct_reports_assignment_context_fk'
    );
    expect(assignmentContextForeignKey?.reference().columns.map((column) => column.name)).toEqual([
      'quest_id',
      'assignment_id',
    ]);
    expect(
      assignmentContextForeignKey?.reference().foreignColumns.map((column) => column.name)
    ).toEqual(['quest_id', 'id']);
    expect(config.indexes.map((index) => index.config.name)).toEqual(
      expect.arrayContaining([
        'admin_conduct_reports_status_created_idx',
        'admin_conduct_reports_quest_created_idx',
        'admin_conduct_reports_filer_created_idx',
        'admin_conduct_reports_reported_member_created_idx',
        'admin_conduct_reports_assignment_idx',
      ])
    );
  });
});
