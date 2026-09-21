import type { AdminContext } from '@/modules/auth';
import { apiError, apiSuccess, type ApiResponse } from '@/shared/api-response';
import { CursorInputError } from '@/shared/cursor';

import type { AdminMemberListQuery, AdminMemberParams } from './admin-member.schema';
import { getAdminMemberDetail, listAdminMembers } from './admin-member.service';

export const listAdminMembersController = async ({
  query,
  set,
}: AdminContext & {
  query: AdminMemberListQuery;
}): Promise<ApiResponse> => {
  try {
    const data = await listAdminMembers(query);
    return apiSuccess(data);
  } catch (error) {
    if (error instanceof CursorInputError) {
      set.status = 400;
      return apiError(error.code, error.message);
    }
    throw error;
  }
};

export const getAdminMemberDetailController = async ({
  params,
  set,
}: AdminContext & {
  params: AdminMemberParams;
}): Promise<ApiResponse> => {
  const data = await getAdminMemberDetail(params.id);
  if (!data) {
    set.status = 404;
    return apiError('MEMBER_NOT_FOUND', 'Member was not found.');
  }
  return apiSuccess(data);
};
