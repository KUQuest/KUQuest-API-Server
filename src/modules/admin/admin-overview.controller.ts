import { apiSuccess } from '@/shared/api-response';
import type { ApiResponse } from '@/shared/api-response';

import { getAdminOverview } from './admin-overview.service';
import type { AdminOverviewData } from './admin-overview.schema';

export const getAdminOverviewController = async (): Promise<ApiResponse<AdminOverviewData>> =>
  apiSuccess(await getAdminOverview());
