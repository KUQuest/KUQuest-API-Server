import type { AdminContext } from '@/modules/auth';
import { apiError, apiSuccess, type ApiResponse } from '@/shared/api-response';

import type {
  AdminLedgerTransactionsQuery,
  AdminMemberFinanceParams,
  AdminQuestFinanceParams,
} from './admin-finance.schema';
import {
  getAdminFinanceOverview,
  getAdminMemberFinanceProfile,
  getAdminQuestFinance,
  getCurrentMoneyPolicy,
  listAdminLedgerTransactions,
  listMoneyPolicyRevisions,
} from './admin-finance.service';

export const getAdminQuestFinanceController = async ({
  params,
  set,
}: AdminContext & {
  params: AdminQuestFinanceParams;
}): Promise<ApiResponse> => {
  const data = await getAdminQuestFinance(params.questId);
  if (!data) {
    set.status = 404;
    return apiError('QUEST_NOT_FOUND', 'Quest was not found.');
  }
  return apiSuccess(data);
};

export const listAdminLedgerTransactionsController = async ({
  query,
}: AdminContext & {
  query: AdminLedgerTransactionsQuery;
}): Promise<ApiResponse> => {
  const data = await listAdminLedgerTransactions(query);
  return apiSuccess(data);
};

export const getAdminFinanceOverviewController = async (): Promise<ApiResponse> => {
  const data = await getAdminFinanceOverview();
  return apiSuccess(data);
};

export const getAdminMemberFinanceProfileController = async ({
  params,
  set,
}: AdminContext & {
  params: AdminMemberFinanceParams;
}): Promise<ApiResponse> => {
  const data = await getAdminMemberFinanceProfile(params.userId);
  if (!data) {
    set.status = 404;
    return apiError('MEMBER_NOT_FOUND', 'Member was not found.');
  }
  return apiSuccess(data);
};

export const getCurrentMoneyPolicyController = async (): Promise<ApiResponse> => {
  const policy = await getCurrentMoneyPolicy();
  return apiSuccess({ policy });
};

export const listMoneyPolicyRevisionsController = async (): Promise<ApiResponse> => {
  const policies = await listMoneyPolicyRevisions();
  return apiSuccess({ policies });
};
