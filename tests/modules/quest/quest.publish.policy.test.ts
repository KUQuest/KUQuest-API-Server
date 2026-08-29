import {
  buildQuestPublishCheck,
  calculateQuestEscrowRequirementSatang,
} from '@/modules/quest/quest.publish.policy';

import { describe, expect, it } from 'bun:test';

const baseSnapshot = {
  tagId: 'tag-1',
  startTime: new Date('2026-08-27T10:00:00.000Z'),
  dueAt: new Date('2026-08-27T12:00:00.000Z'),
  hasImages: true,
  hasLocations: true,
  rewardSatang: 50_000,
  headcount: 2,
  platformFeeBps: 200,
  now: new Date('2026-08-26T10:00:00.000Z'),
};

describe('Quest publish policy', () => {
  it('allows a complete Draft and calculates the total Escrow requirement', () => {
    expect(buildQuestPublishCheck(baseSnapshot)).toMatchObject({
      blockingReasons: [],
      warnings: [],
      escrowRequirement: 1020,
      escrowRequirementSatang: 102000,
      canPublish: true,
    });
  });

  it('uses ceiling fee rounding for every Worker Reward', () => {
    const snapshot = {
      ...baseSnapshot,
      rewardSatang: 50_100,
      headcount: 3,
      platformFeeBps: 333,
    };

    expect(Number(calculateQuestEscrowRequirementSatang(snapshot))).toBe(155_307);
    expect(buildQuestPublishCheck(snapshot)).toMatchObject({
      escrowRequirement: 1_553,
      escrowRequirementSatang: 155_307,
    });
  });

  it('returns blocking reasons in the approved order', () => {
    expect(
      buildQuestPublishCheck({
        ...baseSnapshot,
        tagId: null,
        dueAt: null,
        startTime: new Date('2026-08-25T10:00:00.000Z'),
      }).blockingReasons,
    ).toEqual([
      {
        code: 'QUEST_TAG_REQUIRED',
        message: 'Quest requires a Tag',
      },
      {
        code: 'QUEST_DURATION_REQUIRED',
        message: 'Quest requires an estimated duration',
      },
      {
        code: 'QUEST_START_TIME_NOT_IN_FUTURE',
        message: 'Quest startTime must be in the future',
      },
    ]);
  });

  it('returns non-blocking warnings for missing images and locations', () => {
    expect(
      buildQuestPublishCheck({
        ...baseSnapshot,
        hasImages: false,
        hasLocations: false,
      }),
    ).toMatchObject({
      blockingReasons: [],
      warnings: [
        {
          code: 'QUEST_IMAGES_MISSING',
          message: 'Quest has no images',
        },
        {
          code: 'QUEST_LOCATIONS_MISSING',
          message: 'Quest has no locations',
        },
      ],
      canPublish: true,
    });
  });
});
