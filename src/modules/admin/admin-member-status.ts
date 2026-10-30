import { authUser } from '@/database/schema/auth.schema';
import { unreversedPermanentBanExists } from '@/modules/admin/member-penalty';

import { sql } from 'drizzle-orm';

import type { AdminMemberStatus } from './admin-member.schema';

export const adminMemberStatusSql = () =>
  sql<AdminMemberStatus>`case
    when ${unreversedPermanentBanExists(authUser.id)} then 'PERMANENT_BAN'
    when ${authUser.bannedUntil} > now() then 'TEMPORARY_BAN'
    when ${authUser.redFlagExpiresAt} > now() then 'RED_FLAG'
    else 'NORMAL'
  end`;
