import { auth } from './auth.config';

export interface AuthenticatedSession {
  user: {
    id: string;
  };
}

export type SessionResolver = (
  headers: Headers,
) => Promise<AuthenticatedSession | null>;

export const resolveBetterAuthSession: SessionResolver = async (headers) => {
  const session = await auth.api.getSession({ headers });

  if (!session?.user.id) return null;

  return { user: { id: session.user.id } };
};
