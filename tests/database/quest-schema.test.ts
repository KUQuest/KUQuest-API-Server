import {
  proofSubmission,
  quest,
  questApplication,
  questAssignment,
  questEditRequest,
  questImage,
  questLocation,
  questMode,
  questParticipation,
  questStatus,
  questSettlementCommand,
  questTeamInvitation,
  questTeamMember,
} from '@/database/schema/quest.schema';

import { describe, expect, it } from 'bun:test';
import { getTableColumns } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';

describe('Quest database schema', () => {
  it('stores the Quest Reward as integer Satang', () => {
    const columns = getTableColumns(quest);

    expect(columns).toHaveProperty('rewardSatang');
    expect(columns).not.toHaveProperty('rewardBaht');
    expect(columns.rewardSatang.name).toBe('reward_satang');
    expect(columns.rewardSatang.dataType).toBe('number');
  });

  it('uses the revised Quest vocabularies and actor column names', () => {
    expect(questMode.enumValues).toEqual(['NO_CANDIDATE', 'CANDIDATE']);
    expect(questParticipation.enumValues).toEqual(['SOLO', 'GROUP']);
    expect(questStatus.enumValues).toContain('QUEST_AWAITING_CONSENT');
    expect(getTableColumns(quest)).toHaveProperty('hirerId');
    expect(getTableColumns(quest)).not.toHaveProperty('giverId');
    expect(getTableColumns(questApplication)).toHaveProperty('workerId');
    expect(getTableColumns(questAssignment)).toHaveProperty('workerId');
    expect(getTableColumns(proofSubmission)).toHaveProperty('workerId');
  });

  it('keeps locations label-only and images ordered', () => {
    const locationColumns = getTableColumns(questLocation);
    expect(Object.keys(locationColumns)).toEqual(['id', 'questId', 'label']);
    expect(getTableConfig(questImage).uniqueConstraints).toHaveLength(1);
    expect(getTableConfig(questImage).indexes).toHaveLength(1);
  });

  it('does not persist derived proof or edit deadlines and attempts', () => {
    expect(getTableColumns(proofSubmission)).not.toHaveProperty('attemptNumber');
    expect(getTableColumns(proofSubmission)).not.toHaveProperty('autoApproveAt');
    expect(getTableColumns(questEditRequest)).not.toHaveProperty('expiresAt');
  });

  it('persists replay-safe terminal settlement commands', () => {
    const columns = getTableColumns(questSettlementCommand);
    expect(columns).toHaveProperty('commandId');
    expect(columns).toHaveProperty('requestHash');
    expect(columns).toHaveProperty('resultData');
    expect(columns.actorUserId.name).toBe('actor_user_id');
    expect(columns.actorAdminId.name).toBe('actor_admin_id');
    expect(getTableConfig(questSettlementCommand).uniqueConstraints).toHaveLength(1);
  });

  it('uses a composite team-member key and leader-authorized invitations', () => {
    const memberConfig = getTableConfig(questTeamMember);
    expect(memberConfig.primaryKeys[0]?.columns.map((column) => column.name)).toEqual([
      'team_id',
      'user_id',
    ]);

    const invitationColumns = getTableColumns(questTeamInvitation);
    expect(invitationColumns.expiresAt.default).toBeUndefined();
    expect(getTableConfig(questTeamInvitation).foreignKeys).toHaveLength(3);
    expect(getTableConfig(questTeamInvitation).indexes).toHaveLength(3);
  });
});
