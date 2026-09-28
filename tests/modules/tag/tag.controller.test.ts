import * as tagService from '@/modules/tag/tag.service';
import { listTags } from '@/modules/tag/tag.controller';
import { CursorInputError } from '@/shared/cursor';

import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';

const storedTags = [
  { id: '018f47a7-1c7d-7c98-9a11-690d7e83430c', name: 'Graphic Design', nameTh: null },
  { id: '018f47a7-1c7d-7c98-9a11-690d7e83430d', name: 'Frontend Development', nameTh: null },
];

const mockPage = {
  items: storedTags,
  nextCursor: null,
};

afterEach(() => mock.restore());

describe('Tag controller', () => {
  it('returns the shared success envelope with paginated tags', async () => {
    spyOn(tagService, 'listTags').mockResolvedValue(mockPage);

    expect(await listTags()).toEqual({
      success: true,
      data: mockPage,
    });
  });

  it('forwards search and cursor parameters to the service', async () => {
    const listSpy = spyOn(tagService, 'listTags').mockResolvedValue(mockPage);

    await listTags({
      query: { q: 'design', limit: 10, cursor: 'valid-cursor' },
      set: { status: 200 } as never,
    });

    expect(listSpy).toHaveBeenCalledWith({
      q: 'design',
      limit: 10,
      cursor: 'valid-cursor',
    });
  });

  it('maps CursorInputError to 400 with the error code and message', async () => {
    spyOn(tagService, 'listTags').mockImplementation(() => {
      throw new CursorInputError('INVALID_CURSOR', 'Invalid cursor format');
    });

    const set = { status: 200 };
    const response = await listTags({
      query: { cursor: 'bad-cursor' },
      set: set as never,
    });

    expect(set.status).toBe(400);
    expect(response).toEqual({
      success: false,
      error: { code: 'INVALID_CURSOR', message: 'Invalid cursor format' },
    });
  });
});
