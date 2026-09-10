import { apiSuccess } from '@/shared/api-response';
import type { ApiResponse } from '@/shared/api-response';

import type { Static } from 'elysia';

import { getAdminOverview } from './admin-overview.service';
import type { adminOverviewResponseSchema } from './admin-overview.schema';

type AdminOverviewResponse = Static<typeof adminOverviewResponseSchema>['data'];

export const getAdminOverviewController = async (): Promise<ApiResponse<AdminOverviewResponse>> =>
  apiSuccess(await getAdminOverview());
