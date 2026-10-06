import type { AdminContext } from '@/modules/auth';
import { apiError, apiSuccess, type ApiResponse } from '@/shared/api-response';
import { CursorInputError } from '@/shared/cursor';

import type {
  AdminMemberListQuery,
  AdminMemberParams,
  AdminMemberProfileCollectionQuery,
} from './admin-member.schema';
import {
  getAdminMemberDetail,
  getAdminMemberProfileTags,
  listAdminMemberCertificates,
  listAdminMemberWorkExperiences,
  listAdminMembers,
} from './admin-member.service';
const memberNotFound = (set: AdminContext['set']): ApiResponse => {
  set.status = 404;
  return apiError('MEMBER_NOT_FOUND', 'Member was not found.');
};
const cursorInputErrorResponse = (
  error: unknown,
  set: AdminContext['set']
): ApiResponse | undefined => {
  if (!(error instanceof CursorInputError)) return undefined;

  set.status = 400;
  return apiError(error.code, error.message);
};

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
    const response = cursorInputErrorResponse(error, set);
    if (response) return response;
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
  if (!data) return memberNotFound(set);
  return apiSuccess(data);
};
export const getAdminMemberProfileTagsController = async ({
  params,
  set,
}: AdminContext & {
  params: AdminMemberParams;
}): Promise<ApiResponse> => {
  const data = await getAdminMemberProfileTags(params.id);
  if (!data) return memberNotFound(set);
  return apiSuccess(data);
};

export const listAdminMemberWorkExperiencesController = async ({
  params,
  query,
  set,
}: AdminContext & {
  params: AdminMemberParams;
  query: AdminMemberProfileCollectionQuery;
}): Promise<ApiResponse> => {
  try {
    const data = await listAdminMemberWorkExperiences(params.id, query);
    if (!data) return memberNotFound(set);
    return apiSuccess(data);
  } catch (error) {
    const response = cursorInputErrorResponse(error, set);
    if (response) return response;
    throw error;
  }
};

export const listAdminMemberCertificatesController = async ({
  params,
  query,
  set,
}: AdminContext & {
  params: AdminMemberParams;
  query: AdminMemberProfileCollectionQuery;
}): Promise<ApiResponse> => {
  try {
    const data = await listAdminMemberCertificates(params.id, query);
    if (!data) return memberNotFound(set);
    return apiSuccess(data);
  } catch (error) {
    const response = cursorInputErrorResponse(error, set);
    if (response) return response;
    throw error;
  }
};
