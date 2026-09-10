import type { AdminContext } from '@/modules/auth';
import { apiError, apiSuccess } from '@/shared/api-response';
import type { ApiResponse } from '@/shared/api-response';
import { CursorInputError, decodeCursor, encodeCursor, parsePageLimit } from '@/shared/cursor';

import type { AdminActivityListQuery, AdminActivityListResponse } from './admin-activity-log.schema';
import { listAdminActivity, serializeAdminActivityEntry } from './admin-activity-log.service';

export const listAdminActivityController = async ({
  query,
  set,
}: AdminContext & { query: AdminActivityListQuery }): Promise<ApiResponse<AdminActivityListResponse>> => {
  try {
    const result = await listAdminActivity({
      action: query.action,
      resourceType: query.resourceType,
      resourceId: query.resourceId,
      adminId: query.adminId,
      limit: parsePageLimit(query.limit),
      cursor: decodeCursor(query.cursor),
      sort: query.sort,
    });

    return apiSuccess({
      items: result.items.map(serializeAdminActivityEntry),
      nextCursor: result.nextCursor ? encodeCursor(result.nextCursor) : null,
    });
  } catch (error) {
    if (error instanceof CursorInputError) {
      set.status = 400;
      return apiError(error.code, error.message);
    }
    throw error;
  }
};
