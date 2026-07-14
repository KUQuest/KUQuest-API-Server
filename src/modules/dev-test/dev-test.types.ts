import type { SessionResolver } from '@/modules/auth';

export const DEVELOPMENT_ACTOR_COOKIE = 'kuquest.dev_actor_token';

export interface DevelopmentUserSummary {
  id: string;
  user_id: string;
  email: string;
  name: string;
  first_name: string;
  last_name: string;
}

export interface DevelopmentTestUser extends DevelopmentUserSummary {
  created_by_user_id: string;
  created_at: string;
}

export interface DevelopmentActorSession {
  actor: DevelopmentTestUser;
  expires_at: string;
}

export interface DevelopmentSessionContext {
  root_user: DevelopmentUserSummary;
  active_user: DevelopmentUserSummary;
  acting_as_test_user: boolean;
  actor_session_expires_at: string | null;
}

export interface DevelopmentTestRepository {
  getRealUser(userId: string): Promise<DevelopmentUserSummary | null>;
  listTestUsers(): Promise<DevelopmentTestUser[]>;
  createTestUser(input: {
    createdByUserId: string;
    displayName?: string;
    firstName: string;
    lastName: string;
  }): Promise<DevelopmentTestUser>;
  createActorSession(input: {
    tokenHash: string;
    userId: string;
    activatedByUserId: string;
    expiresAt: Date;
  }): Promise<DevelopmentActorSession | null>;
  resolveActorSession(input: {
    tokenHash: string;
    activatedByUserId: string;
    now: Date;
  }): Promise<DevelopmentActorSession | null>;
  deleteActorSession(input: {
    tokenHash: string;
    activatedByUserId: string;
  }): Promise<void>;
}

export interface DevelopmentActorResolverOptions {
  enabled: boolean;
  cookieName?: string;
}

export interface DevelopmentTestRouteOptions
  extends DevelopmentActorResolverOptions {
  repository: DevelopmentTestRepository;
  rootSessionResolver: SessionResolver;
  trustedOrigins: readonly string[];
  actorSessionTtlSeconds?: number;
  secureCookie?: boolean;
}
