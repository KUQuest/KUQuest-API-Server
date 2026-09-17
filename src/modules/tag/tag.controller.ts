import type { AuthedContext } from '@/modules/auth';
import { apiError, apiSuccess } from '@/shared/api-response';
import type { ApiResponse } from '@/shared/api-response';
import { CursorInputError, parsePageLimit } from '@/shared/cursor';

import { listTags as findTags } from './tag.service';
import type { TagPage } from './tag.service';
import type { TagListQuery } from './tag.schema';

export const listTags = async (
  context?: (Partial<AuthedContext> & { query?: TagListQuery }) | undefined
): Promise<ApiResponse<TagPage>> => {
  const query = context?.query ?? {};
  const set = context?.set;
  try {
    const limit = parsePageLimit(query.limit);
    const result = await findTags({
      q: query.q,
      limit,
      cursor: query.cursor,
    });
    return apiSuccess(result);
  } catch (error) {
    if (error instanceof CursorInputError) {
      if (set) set.status = 400;
      return apiError(error.code, error.message);
    }
    throw error;
  }
};
