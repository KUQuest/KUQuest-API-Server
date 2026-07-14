import { describe, expect, it } from 'bun:test';

import { hashActorToken } from '@/modules/dev-test/dev-test.crypto';
import { createDevelopmentTestRoute } from '@/modules/dev-test/dev-test.route';
import { createDevelopmentActorSessionResolver } from '@/modules/dev-test/dev-test.session';
import type {
  DevelopmentActorSession,
  DevelopmentTestRepository,
  DevelopmentTestUser,
  DevelopmentUserSummary,
} from '@/modules/dev-test/dev-test.types';

const root: DevelopmentUserSummary = {
  id: 'real-user',
  user_id: 'real-user',
  email: 'real@ku.th',
  name: 'Real User',
  first_name: 'Real',
  last_name: 'User',
};

const actor: DevelopmentTestUser = {
  id: 'test-user',
  user_id: 'test-user',
  email: 'test+test-user@ku.th',
  name: 'Test User',
  first_name: 'Test',
  last_name: 'User',
  created_by_user_id: root.id,
  created_at: '2026-07-14T00:00:00.000Z',
};

class FakeRepository implements DevelopmentTestRepository {
  users = [actor];
  actorSessions = new Map<string, DevelopmentActorSession & { owner: string }>();
  lastCreatedInput: Parameters<DevelopmentTestRepository['createTestUser']>[0] | null =
    null;
  lastStoredTokenHash: string | null = null;

  async getRealUser(userId: string) {
    return userId === root.id ? root : null;
  }

  async listTestUsers() {
    return this.users;
  }

  async createTestUser(
    input: Parameters<DevelopmentTestRepository['createTestUser']>[0],
  ) {
    this.lastCreatedInput = input;
    const created = {
      ...actor,
      id: 'new-test-user',
      user_id: 'new-test-user',
      email: 'test+new-test-user@ku.th',
      name: input.displayName ?? `${input.firstName} ${input.lastName}`,
      first_name: input.firstName,
      last_name: input.lastName,
      created_by_user_id: input.createdByUserId,
    };
    this.users.unshift(created);
    return created;
  }

  async createActorSession(
    input: Parameters<DevelopmentTestRepository['createActorSession']>[0],
  ) {
    const selected = this.users.find((candidate) => candidate.id === input.userId);
    if (!selected) return null;
    const session = {
      actor: selected,
      expires_at: input.expiresAt.toISOString(),
      owner: input.activatedByUserId,
    };
    this.lastStoredTokenHash = input.tokenHash;
    this.actorSessions.set(input.tokenHash, session);
    return session;
  }

  async resolveActorSession(
    input: Parameters<DevelopmentTestRepository['resolveActorSession']>[0],
  ) {
    const session = this.actorSessions.get(input.tokenHash);
    if (
      !session ||
      session.owner !== input.activatedByUserId ||
      new Date(session.expires_at) <= input.now
    ) {
      return null;
    }
    return session;
  }

  async deleteActorSession(
    input: Parameters<DevelopmentTestRepository['deleteActorSession']>[0],
  ) {
    const session = this.actorSessions.get(input.tokenHash);
    if (session?.owner === input.activatedByUserId) {
      this.actorSessions.delete(input.tokenHash);
    }
  }
}

const request = (
  path: string,
  input: { method?: string; body?: unknown; cookie?: string; origin?: string } = {},
) => {
  const headers = new Headers({
    'content-type': 'application/json',
    origin: input.origin ?? 'http://localhost:3000',
  });
  if (input.cookie) headers.set('cookie', input.cookie);
  return new Request(`http://localhost${path}`, {
    method: input.method ?? 'GET',
    headers,
    body: input.body === undefined ? undefined : JSON.stringify(input.body),
  });
};

const createRoute = (repository: FakeRepository, enabled = true) =>
  createDevelopmentTestRoute({
    enabled,
    repository,
    rootSessionResolver: async () => ({ user: { id: root.id } }),
    trustedOrigins: ['http://localhost:3000'],
    actorSessionTtlSeconds: 3600,
  });

describe('development synthetic normal-user routes', () => {
  it('lists the shared synthetic-user pool in the canonical envelope', async () => {
    const response = await createRoute(new FakeRepository()).handle(
      request('/v1/development/test-users'),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      error: null,
      data: { items: [{ user_id: actor.id, email: actor.email }] },
    });
    expect(body.trace_id).toEqual(expect.any(String));
  });

  it('creates a normal zero-balance user through the repository transaction', async () => {
    const repository = new FakeRepository();
    const response = await createRoute(repository).handle(
      request('/v1/development/test-users', {
        method: 'POST',
        body: { name: 'Synthetic Worker' },
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.data).toMatchObject({
      first_name: 'Synthetic',
      last_name: 'Worker',
      created_by_user_id: root.id,
    });
    expect(repository.lastCreatedInput).toEqual({
      createdByUserId: root.id,
      displayName: 'Synthetic Worker',
      firstName: 'Synthetic',
      lastName: 'Worker',
    });
  });

  it('sets only an opaque actor token and stores only its hash', async () => {
    const repository = new FakeRepository();
    const response = await createRoute(repository).handle(
      request('/v1/development/actor-sessions', {
        method: 'POST',
        body: { user_id: actor.id },
      }),
    );
    const body = await response.json();
    const setCookie = response.headers.get('set-cookie') ?? '';
    const rawToken = /kuquest\.dev_actor_token=([^;]+)/.exec(setCookie)?.[1];

    expect(response.status).toBe(201);
    expect(body.data.active_user.id).toBe(actor.id);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(rawToken).toBeTruthy();
    expect(repository.lastStoredTokenHash).toBe(hashActorToken(rawToken!));
    expect(setCookie).not.toContain(repository.lastStoredTokenHash!);
  });

  it('shows and clears the active actor context without clearing root auth', async () => {
    const repository = new FakeRepository();
    const app = createRoute(repository);
    const activation = await app.handle(
      request('/v1/development/actor-sessions', {
        method: 'POST',
        body: { user_id: actor.id },
      }),
    );
    const actorCookie = activation.headers.get('set-cookie')!.split(';')[0];

    const contextResponse = await app.handle(
      request('/v1/development/session-context', { cookie: actorCookie }),
    );
    const context = (await contextResponse.json()).data;
    expect(context).toMatchObject({
      root_user: { id: root.id },
      active_user: { id: actor.id },
      acting_as_test_user: true,
    });

    const clearResponse = await app.handle(
      request('/v1/development/actor-session', {
        method: 'DELETE',
        cookie: actorCookie,
      }),
    );
    expect(clearResponse.status).toBe(200);
    expect(clearResponse.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(repository.actorSessions.size).toBe(0);
  });

  it('rejects mutation from an untrusted browser origin', async () => {
    const response = await createRoute(new FakeRepository()).handle(
      request('/v1/development/test-users', {
        method: 'POST',
        origin: 'https://attacker.example',
        body: { first_name: 'Bad', last_name: 'Origin' },
      }),
    );
    const body = await response.json();
    expect(response.status).toBe(403);
    expect(body.error.code).toBe('FORBIDDEN');
  });

  it('returns a canonical 404 in production mode', async () => {
    const response = await createRoute(new FakeRepository(), false).handle(
      request('/v1/development/test-users'),
    );
    const body = await response.json();
    expect(response.status).toBe(404);
    expect(body.error.code).toBe('DEVELOPMENT_FEATURE_DISABLED');
  });
});

describe('development composite session resolver', () => {
  it('uses the actor only while a matching real Better Auth root session exists', async () => {
    const repository = new FakeRepository();
    const token = 'opaque-test-token';
    await repository.createActorSession({
      tokenHash: hashActorToken(token),
      userId: actor.id,
      activatedByUserId: root.id,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const resolver = createDevelopmentActorSessionResolver(
      repository,
      async () => ({ user: { id: root.id } }),
      { enabled: true },
    );

    const session = await resolver(
      new Headers({ cookie: `kuquest.dev_actor_token=${token}` }),
    );
    expect(session?.user.id).toBe(actor.id);

    const anonymousResolver = createDevelopmentActorSessionResolver(
      repository,
      async () => null,
      { enabled: true },
    );
    expect(
      await anonymousResolver(
        new Headers({ cookie: `kuquest.dev_actor_token=${token}` }),
      ),
    ).toBeNull();
  });

  it('falls back to the real root when the actor token is invalid or disabled', async () => {
    const repository = new FakeRepository();
    const rootResolver = async () => ({ user: { id: root.id } });
    const invalid = createDevelopmentActorSessionResolver(
      repository,
      rootResolver,
      { enabled: true },
    );
    expect(
      (
        await invalid(
          new Headers({ cookie: 'kuquest.dev_actor_token=unknown' }),
        )
      )?.user.id,
    ).toBe(root.id);

    const disabled = createDevelopmentActorSessionResolver(
      repository,
      rootResolver,
      { enabled: false },
    );
    expect((await disabled(new Headers()))?.user.id).toBe(root.id);
  });
});
