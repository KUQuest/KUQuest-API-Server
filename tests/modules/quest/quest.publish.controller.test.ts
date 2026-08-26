import * as questService from '@/modules/quest/quest.service';
import {
  getQuestPublishCheckController,
  publishQuestController,
} from '@/modules/quest/quest.controller';

import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';

const session = { user: { id: 'hirer-1' } };
const questId = '018f47a7-1c7d-7c98-9a11-690d7e83430c';

afterEach(() => mock.restore());

describe('Quest publishing controllers', () => {
  it('returns the publish preview in the shared envelope', async () => {
    spyOn(questService, 'getQuestPublishCheck').mockResolvedValue({
      blockingReasons: [],
      warnings: [],
      escrowRequirement: 500,
      canPublish: true,
    });

    const result = await getQuestPublishCheckController({
      params: { questId },
      session: session as never,
      set: {} as never,
    });

    expect(result).toEqual({
      success: true,
      data: {
        blockingReasons: [],
        warnings: [],
        escrowRequirement: 500,
        canPublish: true,
      },
    });
  });

  it('maps an unavailable Quest to QUEST_NOT_FOUND', async () => {
    spyOn(questService, 'getQuestPublishCheck').mockResolvedValue(undefined);
    const set: { status?: number } = {};

    const result = await getQuestPublishCheckController({
      params: { questId },
      session: session as never,
      set: set as never,
    });

    expect(set.status).toBe(404);
    expect(result).toEqual({
      success: false,
      error: { code: 'QUEST_NOT_FOUND', message: 'Quest not found' },
    });
  });

  it('rejects a non-Draft publish check and publish with 409', async () => {
    spyOn(questService, 'getQuestPublishCheck').mockResolvedValue({ outcome: 'not-draft' });
    spyOn(questService, 'publishQuest').mockResolvedValue({ outcome: 'not-draft' });
    const checkSet: { status?: number } = {};
    const publishSet: { status?: number } = {};

    const checkResult = await getQuestPublishCheckController({
      params: { questId },
      session: session as never,
      set: checkSet as never,
    });
    const publishResult = await publishQuestController({
      params: { questId },
      session: session as never,
      set: publishSet as never,
    });

    expect(checkSet.status).toBe(409);
    expect(publishSet.status).toBe(409);
    expect(checkResult).toEqual({
      success: false,
      error: { code: 'QUEST_NOT_DRAFT', message: 'Only Draft Quests can be published' },
    });
    expect(publishResult).toEqual(checkResult);
  });

  it('returns only the first blocking reason when publish fails', async () => {
    spyOn(questService, 'publishQuest').mockResolvedValue({
      outcome: 'blocked',
      check: {
        blockingReasons: [
          { code: 'QUEST_TAG_REQUIRED', message: 'Quest requires a Tag' },
          { code: 'QUEST_DURATION_REQUIRED', message: 'Quest requires an estimated duration' },
        ],
        warnings: [],
        escrowRequirement: 500,
        canPublish: false,
      },
    });
    const set: { status?: number } = {};

    const result = await publishQuestController({
      params: { questId },
      session: session as never,
      set: set as never,
    });

    expect(set.status).toBe(409);
    expect(result).toEqual({
      success: false,
      error: { code: 'QUEST_TAG_REQUIRED', message: 'Quest requires a Tag' },
    });
  });

  it('returns success after publishing', async () => {
    spyOn(questService, 'publishQuest').mockResolvedValue({ outcome: 'published' });

    const result = await publishQuestController({
      params: { questId },
      session: session as never,
      set: {} as never,
    });

    expect(result).toEqual({ success: true });
  });
});
