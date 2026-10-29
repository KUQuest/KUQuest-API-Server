import { getTrustedOrigins } from '@/modules/auth';
import type { AdminContext } from '@/modules/auth';
import { apiError } from '@/shared/api-response';
import type { ApiError } from '@/shared/api-response';

import { adminUpdateSseResponse, ensureAdminUpdateListener } from './admin-update.delivery';

const trustedOrigins = getTrustedOrigins();

export const subscribeAdminUpdatesController = async ({
  request,
  adminSession,
  set,
}: AdminContext & { request: Request }): Promise<Response | ApiError> => {
  const origin = request.headers.get('origin');
  if (origin !== null && !trustedOrigins.includes(origin)) {
    set.status = 403;
    return apiError('FORBIDDEN', 'Origin not allowed');
  }

  try {
    await ensureAdminUpdateListener();
  } catch {
    set.status = 503;
    return apiError('ADMIN_UPDATES_UNAVAILABLE', 'Admin updates are unavailable');
  }

  return adminUpdateSseResponse(new Date(adminSession.session.expiresAt));
};
