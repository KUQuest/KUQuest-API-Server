import { apiSuccess } from '@/shared/api-response';
import type { ApiResponse } from '@/shared/api-response';

import { listTags as findTags } from './tag.service';
import type { Tag } from './tag.service';

export const listTags = async (): Promise<ApiResponse<Tag[]>> =>
  apiSuccess(await findTags());
