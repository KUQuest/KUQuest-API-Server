import { isMemberBanned } from '@/modules/admin/member-penalty';

type MemberBanClosableSocket = {
  close: (code: number, reason: string) => unknown;
};

export const closeSocketForActiveMemberBan = async (
  socket: MemberBanClosableSocket,
  memberId: string
): Promise<boolean> => {
  if (!(await isMemberBanned(memberId))) return false;

  socket.close(4403, 'Member Ban is active');
  return true;
};
