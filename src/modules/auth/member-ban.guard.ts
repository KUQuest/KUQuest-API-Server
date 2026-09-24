import { readMemberPenaltyRestriction } from '@/modules/admin/member-penalty';
import { apiError } from '@/shared/api-response';

import { Elysia } from 'elysia';

import type { AuthenticatedSession } from './auth.guard';

export const memberBanGuard = new Elysia({ name: 'member-ban-guard' }).onBeforeHandle(
  { as: 'scoped' },
  async (context) => {
    // This guard is chained after authGuard, which narrows session before the request runs.
    const { session, status } = context as typeof context & { session: AuthenticatedSession };
    const restriction = await readMemberPenaltyRestriction(session.user.id);
    if (restriction.banned) {
      return status(403, apiError('MEMBER_BANNED', 'This Member is banned.'));
    }
  }
);
