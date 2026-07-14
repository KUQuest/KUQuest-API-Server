export interface JobWorkerFields {
  intended_payee_user_id?: string | null;
  selected_worker_user_id?: string | null;
}

export interface IdentifiedUser {
  id?: string;
  user_id?: string;
}

export const userIdentifier = (user?: IdentifiedUser | null): string =>
  user?.user_id ?? user?.id ?? '';

export const selectedWorkerIdentifier = (job?: JobWorkerFields | null): string =>
  job?.intended_payee_user_id ?? job?.selected_worker_user_id ?? '';

export const isSelectedWorker = (
  job?: JobWorkerFields | null,
  user?: IdentifiedUser | null,
): boolean => {
  const workerId = selectedWorkerIdentifier(job);
  return workerId !== '' && workerId === userIdentifier(user);
};

export const findUserByIdentifier = <T extends IdentifiedUser>(
  users: T[],
  targetId: string,
): T | undefined => users.find((user) => userIdentifier(user) === targetId);
