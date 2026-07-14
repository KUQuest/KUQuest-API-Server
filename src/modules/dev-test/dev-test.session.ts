import { isAllowedEmail, type SessionResolver } from '@/modules/auth';

import { readCookie } from './dev-test.cookie';
import { hashActorToken } from './dev-test.crypto';
import {
  DEVELOPMENT_ACTOR_COOKIE,
  type DevelopmentActorResolverOptions,
  type DevelopmentTestRepository,
} from './dev-test.types';

export const createDevelopmentActorSessionResolver = (
  repository: DevelopmentTestRepository,
  rootSessionResolver: SessionResolver,
  options: DevelopmentActorResolverOptions,
): SessionResolver =>
  async (headers) => {
    const rootSession = await rootSessionResolver(headers);
    if (!rootSession?.user.id) return null;

    const rootUser = await repository.getRealUser(rootSession.user.id);
    if (!rootUser || !isAllowedEmail(rootUser.email)) return null;

    if (!options.enabled) return { user: { id: rootUser.id } };

    const token = readCookie(
      headers,
      options.cookieName ?? DEVELOPMENT_ACTOR_COOKIE,
    );
    if (!token) return { user: { id: rootUser.id } };

    const actorSession = await repository.resolveActorSession({
      tokenHash: hashActorToken(token),
      activatedByUserId: rootUser.id,
      now: new Date(),
    });

    return {
      user: { id: actorSession?.actor.id ?? rootUser.id },
    };
  };
