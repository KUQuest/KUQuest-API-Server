import * as questService from '@/modules/quest/quest.service';
import {
  createQuestController,
  getQuestDetailController,
  listBoardQuestsController,
} from '@/modules/quest/quest.controller';

import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';

const session = { user: { id: 'hirer-1' } };
const questId = '018f47a7-1c7d-7c98-9a11-690d7e83430c';

const createInput = {
  title: 'Design a poster',
  description: 'Create a poster for the event',
  condition: 'The poster must be readable',
  mode: 'FIRST_COME_FIRST_SERVED' as const,
  participation: 'SINGLE' as const,
  reward: 500,
  headcount: 1,
  startTime: '2026-08-26T10:00:00.000Z',
  dueAt: '2026-08-26T12:00:00.000Z',
  proofRequired: true,
  locations: [],
};

const listQuery = {
  limit: 20,
};

afterEach(() => mock.restore());

describe('Quest controllers', () => {
  it('creates a Draft and returns its id in the shared envelope', async () => {
    spyOn(questService, 'createQuest').mockResolvedValue({ id: questId });

    const result = await createQuestController({
      body: createInput,
      session: session as never,
      set: {} as never,
    });

    expect(result).toEqual({ success: true, data: { id: questId } });
    expect(questService.createQuest).toHaveBeenCalledWith('hirer-1', createInput);
  });

  it('maps a private Quest result to QUEST_NOT_FOUND', async () => {
    spyOn(questService, 'getQuestDetail').mockResolvedValue(undefined);
    const set: { status?: number } = {};

    const result = await getQuestDetailController({
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

  it('rejects caller coordinates supplied as an incomplete pair', async () => {
    const set: { status?: number } = {};
    const result = await listBoardQuestsController({
      query: { latitude: 13.8 } as never,
      session: session as never,
      set: set as never,
    });

    expect(set.status).toBe(400);
    expect(result).toEqual({
      success: false,
      error: {
        code: 'INVALID_COORDINATES',
        message: 'latitude and longitude must be supplied together',
      },
    });
  });

  it('returns the approved cursor list shape', async () => {
    spyOn(questService, 'listBoardQuests').mockResolvedValue({
      items: [],
      nextCursor: null,
    });

    const result = await listBoardQuestsController({
      query: listQuery,
      session: session as never,
      set: {} as never,
    });

    expect(result).toEqual({ success: true, data: { items: [], nextCursor: null } });
  });
});
