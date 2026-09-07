import * as questService from '@/modules/quest/quest.service';
import {
  createQuestController,
  createQuestEditRequestController,
  editQuestController,
  getQuestEditRequestController,
  respondToQuestEditRequestController,
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
  mode: 'NO_CANDIDATE' as const,
  participation: 'SOLO' as const,
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

  it('maps an empty cursor to INVALID_CURSOR', async () => {
    const set: { status?: number } = {};
    const result = await listBoardQuestsController({
      query: { cursor: '' } as never,
      session: session as never,
      set: set as never,
    });

    expect(set.status).toBe(400);
    expect(result).toEqual({
      success: false,
      error: { code: 'INVALID_CURSOR', message: 'cursor must be a non-empty string' },
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

  it('returns the complete consent request envelope', async () => {
    const expiresAt = new Date('2026-08-26T10:05:00.000Z');
    spyOn(questService, 'createQuestEditRequest').mockResolvedValue({
      requestId: questId,
      status: 'EDIT_REQUEST_PENDING',
      expiresAt,
    });

    const result = await createQuestEditRequestController({
      params: { questId },
      body: { title: 'Changed title' },
      session: session as never,
      set: {} as never,
    });

    expect(result).toEqual({
      success: true,
      data: { requestId: questId, status: 'EDIT_REQUEST_PENDING', expiresAt: expiresAt.toISOString() },
    });
  });

  it('returns a consent response with the declared fields', async () => {
    spyOn(questService, 'respondToQuestEditRequest').mockResolvedValue({
      requestId: questId,
      status: 'EDIT_REQUEST_APPROVED',
    });

    const result = await respondToQuestEditRequestController({
      params: { requestId: questId },
      body: { decision: 'EDIT_RESPONSE_APPROVED' },
      session: session as never,
      set: {} as never,
    });

    expect(result).toEqual({
      success: true,
      data: { requestId: questId, status: 'EDIT_REQUEST_APPROVED' },
    });
  });

  it('serializes all consent request detail dates', async () => {
    spyOn(questService, 'getQuestEditRequest').mockResolvedValue({
      id: questId,
      questId,
      requestedByUserId: 'hirer-1',
      previousQuestStatus: 'QUEST_ASSIGNED',
      status: 'EDIT_REQUEST_PENDING',
      proposedChanges: { title: 'Changed title' },
      createdAt: new Date('2026-08-26T10:00:00.000Z'),
      expiresAt: new Date('2026-08-26T10:05:00.000Z'),
      responses: [{ userId: 'worker-1', decision: null, respondedAt: null }] as never,
    });

    const result = await getQuestEditRequestController({
      params: { requestId: questId },
      session: session as never,
      set: {} as never,
    });

    expect(result).toEqual({
      success: true,
      data: {
        id: questId,
        questId,
        requestedByUserId: 'hirer-1',
        previousQuestStatus: 'QUEST_ASSIGNED',
        status: 'EDIT_REQUEST_PENDING',
        proposedChanges: { title: 'Changed title' },
        createdAt: '2026-08-26T10:00:00.000Z',
        expiresAt: '2026-08-26T10:05:00.000Z',
        responses: [{ userId: 'worker-1', decision: null, respondedAt: null }],
      },
    });
  });

  it('points selected participation at the consent edit flow', async () => {
    spyOn(questService, 'editQuest').mockResolvedValue({ outcome: 'requires-consent' });
    const set: { status?: number } = {};

    const result = await editQuestController({
      params: { questId },
      body: { title: 'Changed title' },
      session: session as never,
      set: set as never,
    });

    expect(set.status).toBe(409);
    expect(result).toEqual({
      success: false,
      error: {
        code: 'QUEST_EDIT_REQUIRES_CONSENT',
        message: 'Quest edits require consent after participation starts',
      },
    });
  });

  it('returns the updated Quest detail after a successful edit', async () => {
    const detail = {
      id: questId,
      title: 'Changed title',
      description: null,
      condition: 'A completed result',
      reward: 500,
      tag: null,
      mode: 'NO_CANDIDATE' as const,
      participation: 'SOLO' as const,
      questStatus: 'QUEST_OPEN' as const,
      headcount: 1,
      startTime: '2026-08-26T10:00:00.000Z',
      dueAt: null,
      estimatedDurationMinutes: null,
      proofRequired: true,
      hirerName: 'Quest Hirer',
      locations: [],
      images: [],
    };
    spyOn(questService, 'editQuest').mockResolvedValue({ id: questId });
    spyOn(questService, 'getQuestDetail').mockResolvedValue(detail as never);

    const result = await editQuestController({
      params: { questId },
      body: { title: 'Changed title' },
      session: session as never,
      set: {} as never,
    });

    expect(result).toEqual({ success: true, data: detail });
  });
});
