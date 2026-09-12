import { adminAuth } from './admin-auth.config';

type AdminSession = Awaited<ReturnType<typeof adminAuth.api.getSession>>;

const adminSessionPromises = new WeakMap<Request, Promise<AdminSession>>();

export const getAdminSession = (request: Request): Promise<AdminSession> => {
  const existingPromise = adminSessionPromises.get(request);
  if (existingPromise) return existingPromise;

  const sessionPromise = adminAuth.api.getSession({ headers: request.headers });
  adminSessionPromises.set(request, sessionPromise);
  return sessionPromise;
};
