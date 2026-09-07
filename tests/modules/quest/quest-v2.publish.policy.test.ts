import {
  buildQuestV2PublishCheck,
  calculateQuestV2FundingQuote,
} from '@/modules/quest/quest-v2.publish.policy';
import { positiveSatang, satang } from '@/modules/wallet';

import { describe, expect, it } from 'bun:test';

const policy = {
  feeRoundingMode: 'UP' as const,
  platformFeeBps: 200,
  policyRevision: 1,
  policyRevisionId: '018f47a7-1c7d-7c98-9a11-690d7e834303',
  minimumFundingReservationSatang: satang(100),
  maximumFundingReservationSatang: satang(70_000_000),
  walletStatus: 'ACTIVE' as const,
};

describe('Quest v2 publish policy', () => {
  it('splits an inclusive ฿20.00 total into ฿19.60 Reward and ฿0.40 Platform Fee', () => {
    const quote = calculateQuestV2FundingQuote({
      questFundingTotalSatang: positiveSatang(2_000),
      headcount: 1,
      ...policy,
    });

    expect(quote).toMatchObject({
      questFundingTotalSatang: 2_000,
      questRewardSatang: 1_960,
      platformFeeSatang: 40,
      escrowRequirementSatang: 2_000,
    });
    expect(quote).not.toHaveProperty('questFundingTotal');
    expect(quote).not.toHaveProperty('questReward');
    expect(quote).not.toHaveProperty('platformFee');
    expect(quote).not.toHaveProperty('escrowRequirement');
  });

  it('keeps the one-satang rounding remainder in the Platform Fee', () => {
    expect(calculateQuestV2FundingQuote({
      questFundingTotalSatang: positiveSatang(103),
      headcount: 1,
      ...policy,
    })).toMatchObject({
      questRewardSatang: 100,
      platformFeeSatang: 3,
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
    });
  });

  it('blocks a GROUP Quest whose headcount is below two Workers', () => {
    const check = buildQuestV2PublishCheck({
      ...policy,
      participation: 'GROUP',
      tagId: 'tag-1',
      conditionValid: true,
      startTime: new Date('2026-09-01T10:00:00.000Z'),
      dueAt: new Date('2026-09-01T12:00:00.000Z'),
      now: new Date('2026-08-31T08:00:00.000Z'),
      questFundingTotalSatang: positiveSatang(103),
      headcount: 1,
      spendingBalanceSatang: positiveSatang(2_000),
    });

    expect(check.blockingReasons).toContainEqual({
      code: 'QUEST_HEADCOUNT_INVALID',
      message: 'GROUP participation requires a headcount between 2 and 20',
    });
    expect(check.canPublish).toBe(false);
  });

  it('reports every Draft correction and still returns the funding quote', () => {
    const check = buildQuestV2PublishCheck({
      ...policy,
      participation: 'SINGLE',
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
      participation: 'SINGLE',
      tagId: 'tag-1',
      conditionValid: true,
      startTime: new Date('2026-08-31T10:00:00.000Z'),
      dueAt: new Date('2026-08-31T09:00:00.000Z'),
      now: new Date('2026-08-31T08:00:00.000Z'),
      questFundingTotalSatang: positiveSatang(2_000),
      headcount: 1,
      spendingBalanceSatang: positiveSatang(2_000),
      minimumFundingReservationSatang: satang(100),
      maximumFundingReservationSatang: satang(70_000_000),
    });

    expect(check.blockingReasons).toEqual([
      {
        code: 'QUEST_DUE_AT_NOT_AFTER_START_TIME',
        message: 'Quest dueAt must be after startTime',
      },
    ]);
  });

  it.each([
    ['below the minimum', 104, 70_000_000],
    ['above the maximum', 100, 102],
  ])('reports a Quest Escrow amount %s in the active Money Policy', (_, minimum, maximum) => {
    const check = buildQuestV2PublishCheck({
      ...policy,
      participation: 'SINGLE',
      minimumFundingReservationSatang: satang(minimum),
      maximumFundingReservationSatang: satang(maximum),
      tagId: 'tag-1',
      conditionValid: true,
      startTime: new Date('2026-09-01T10:00:00.000Z'),
      dueAt: new Date('2026-09-01T12:00:00.000Z'),
      now: new Date('2026-08-31T08:00:00.000Z'),
      questFundingTotalSatang: positiveSatang(103),
      headcount: 1,
      spendingBalanceSatang: positiveSatang(2_000),
    });

    expect(check.blockingReasons).toContainEqual({
      code: 'QUEST_ESCROW_AMOUNT_OUT_OF_RANGE',
      message: 'Quest Escrow amount is outside the active Money Policy limits',
    });
    expect(check.canPublish).toBe(false);
  });

  it.each([
    ['FROZEN', 'FROZEN'],
    ['SUSPENDED', 'SUSPENDED'],
    ['CLOSED', 'CLOSED'],
  ] as const)('blocks a %s Wallet from publish readiness', (_, walletStatus) => {
    const check = buildQuestV2PublishCheck({
      ...policy,
      participation: 'SINGLE',
      walletStatus,
      tagId: 'tag-1',
      conditionValid: true,
      startTime: new Date('2026-09-01T10:00:00.000Z'),
      dueAt: new Date('2026-09-01T12:00:00.000Z'),
      now: new Date('2026-08-31T08:00:00.000Z'),
      questFundingTotalSatang: positiveSatang(2_000),
      headcount: 1,
      spendingBalanceSatang: positiveSatang(2_000),
    });

    expect(check.blockingReasons).toContainEqual({
      code: 'WALLET_NOT_ACTIVE',
      message: `Wallet status ${walletStatus} does not permit FUNDING_RESERVATION.`,
    });
    expect(check.canPublish).toBe(false);
  });

  it('reports an invalid dueAt and a startTime at the Server time boundary', () => {
    const check = buildQuestV2PublishCheck({
      ...policy,
      participation: 'SINGLE',
      tagId: 'tag-1',
      conditionValid: true,
      startTime: new Date('2026-08-31T08:00:00.000Z'),
      dueAt: new Date('invalid'),
      now: new Date('2026-08-31T08:00:00.000Z'),
      questFundingTotalSatang: positiveSatang(2_000),
      headcount: 1,
      spendingBalanceSatang: positiveSatang(2_000),
    });

    expect(check.blockingReasons).toEqual([
      {
        code: 'QUEST_DUE_AT_INVALID',
        message: 'Quest dueAt must be a valid date-time',
      },
      {
        code: 'QUEST_START_TIME_NOT_IN_FUTURE',
        message: 'Quest startTime must be in the future',
      },
    ]);
  });
});
