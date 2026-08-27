import * as reviewService from '@/modules/quest/quest-review.service';
import { createReviewController } from '@/modules/quest/quest-review.controller';

import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';

const session = { user: { id: 'hirer-1' } };
const set = {} as { status?: number };

const input = {
  revieweeId: 'worker-1',
  rating: 5,
  comment: 'Great work',
};

afterEach(() => mock.restore());

describe('createReviewController', () => {
  it('returns a deterministic conflict for a duplicate create', async () => {
    spyOn(reviewService, 'createReview').mockResolvedValue({ outcome: 'already-exists' });

    const result = await createReviewController({
      session: session as never,
      set,
      params: { questId: 'quest-1' },
      body: input,
    } as never);

    expect(set.status).toBe(409);
    expect(result).toEqual({
      success: false,
      error: {
        code: 'REVIEW_ALREADY_EXISTS',
        message: 'A Review already exists for this Quest and direction',
      },
    });
  });
});
