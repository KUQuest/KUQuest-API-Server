import type { AdminContext } from '@/modules/auth';
import { apiError, apiSuccess, type ApiResponse } from '@/shared/api-response';

import type { AdminSearchQuery } from './admin-search.schema';
import { searchAdminRecords } from './admin-search.service';

export const searchAdminController = async ({
  query,
  set,
}: AdminContext & { query: AdminSearchQuery }): Promise<ApiResponse> => {
  const trimmedQuery = query.q.trim();
  const queryLength = Array.from(trimmedQuery).length;

  if (queryLength < 1 || queryLength > 100) {
    set.status = 400;
    return apiError('INVALID_QUERY', 'Search query is invalid.');
  }

  return apiSuccess({ items: await searchAdminRecords(trimmedQuery, query.kind) });
};
