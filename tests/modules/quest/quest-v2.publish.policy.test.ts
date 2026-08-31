import {
  buildQuestV2PublishCheck,
  calculateQuestV2FundingQuote,
} from '@/modules/quest/quest-v2.publish.policy';
import { positiveSatang } from '@/modules/wallet';

import { describe, expect, it } from 'bun:test';

const policy = {
  feeRoundingMode: 'UP' as const,
  platformFeeBps: 200,
  policyRevision: 1,
  policyRevisionId: '018f47a7-1c7d-7c98-9a11-690d7e834303',
  minimumFundingReservationSatang: 100,
  maximumFundingReservationSatang: 70_000_000,
};

describe('Quest v2 publish policy', () => {
  it('splits an inclusive ฿20.00 total into ฿19.60 Reward and ฿0.40 Platform Fee', () => {
    expect(calculateQuestV2FundingQuote({
      questFundingTotalSatang: positiveSatang(2_000),
      headcount: 1,
      ...policy,
    })).toMatchObject({
      questFundingTotalSatang: 2_000,
      questRewardSatang: 1_960,
      platformFeeSatang: 40,
      escrowRequirementSatang: 2_000,
      questFundingTotal: 20,
      questReward: 19.6,
      platformFee: 0.4,
      escrowRequirement: 20,
    });
  });

  it('keeps the one-satang rounding remainder in the Platform Fee', () => {
    expect(calculateQuestV2FundingQuote({
      questFundingTotalSatang: positiveSatang(103),
      headcount: 1,
      ...policy,
    })).toMatchObject({
      questRewardSatang: 100,
      platformFeeSatang: 3,
      questReward: 1,
      platformFee: 0.03,
    });
  });

  it('multiplies the exact per-slot total by headcount', () => {
    expect(calculateQuestV2FundingQuote({
      questFundingTotalSatang: positiveSatang(103),
      headcount: 3,
      ...policy,
    })).toMatchObject({
      questRewardSatang: 100,
      platformFeeSatang: 3,
      escrowRequirementSatang: 309,
      escrowRequirement: 3.09,
    });
  });

  it('reports every Draft correction and still returns the funding quote', () => {
    const check = buildQuestV2PublishCheck({
      ...policy,
      tagId: null,
      conditionValid: false,
      startTime: new Date('2026-08-30T00:00:00.000Z'),
      dueAt: null,
      now: new Date('2026-08-31T00:00:00.000Z'),
      questFundingTotalSatang: positiveSatang(103),
      headcount: 1,
      spendingBalanceSatang: positiveSatang(1),
    });

    expect(check.canPublish).toBe(false);
    expect(check.blockingReasons).toEqual(expect.arrayContaining([
      { code: 'QUEST_TAG_REQUIRED', message: 'Quest requires a Tag' },
      { code: 'QUEST_CONDITION_REQUIRED', message: 'Quest requires at least one Condition Item' },
      { code: 'QUEST_DUE_AT_REQUIRED', message: 'Quest requires a dueAt' },
      { code: 'QUEST_START_TIME_NOT_IN_FUTURE', message: 'Quest startTime must be in the future' },
      { code: 'INSUFFICIENT_SPENDING_BALANCE', message: 'Spending Balance is insufficient for Quest Escrow' },
    ]));
    expect(check.warnings).toEqual([]);
    expect(Number(check.questRewardSatang)).toBe(100);
  });

  it('reports a dueAt that is not after startTime', () => {
    const check = buildQuestV2PublishCheck({
      ...policy,
      tagId: 'tag-1',
      conditionValid: true,
      startTime: new Date('2026-08-31T10:00:00.000Z'),
      dueAt: new Date('2026-08-31T09:00:00.000Z'),
      now: new Date('2026-08-31T08:00:00.000Z'),
      questFundingTotalSatang: positiveSatang(2_000),
      headcount: 1,
      spendingBalanceSatang: positiveSatang(2_000),
      minimumFundingReservationSatang: 100,
      maximumFundingReservationSatang: 70_000_000,
    });

    expect(check.blockingReasons).toEqual([
      {
        code: 'QUEST_DUE_AT_NOT_AFTER_START_TIME',
        message: 'Quest dueAt must be after startTime',
      },
    ]);
  });
});
