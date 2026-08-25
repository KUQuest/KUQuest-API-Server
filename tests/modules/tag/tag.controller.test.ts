import * as tagService from '@/modules/tag/tag.service';
import { listTags } from '@/modules/tag/tag.controller';

import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';

const storedTags = [
  { id: '018f47a7-1c7d-7c98-9a11-690d7e83430c', name: 'Design' },
  { id: '018f47a7-1c7d-7c98-9a11-690d7e83430d', name: 'Frontend' },
];

afterEach(() => mock.restore());

describe('Tag controller', () => {
  it('returns the shared success envelope with a direct Tag array', async () => {
    spyOn(tagService, 'listTags').mockResolvedValue(storedTags);

    expect(await listTags()).toEqual({
      success: true,
      data: storedTags,
    });
  });
});
