import { db } from '@/database/client';
import { department, faculty } from '@/database/schema/academic.schema';
import { authUser } from '@/database/schema/auth.schema';
import { file } from '@/database/schema/file.schema';
import { toWorkChatAvatar, type WorkChatAvatar } from '@/modules/work-chat/work-chat.service';

import { and, eq, inArray, isNull } from 'drizzle-orm';

import { getReceivedRatings } from '../../v1/services/quest-review.service';

export type MemberSummary = {
  id: string;
  displayName: string;
  avatar: WorkChatAvatar;
  faculty: string | null;
  department: string | null;
  ratingAverage: number | null;
};

const formerMemberName = 'Former member';

const formerMember = (id: string): MemberSummary => ({
  id,
  displayName: formerMemberName,
  avatar: null,
  faculty: null,
  department: null,
  ratingAverage: null,
});

/**
 * Reads the public-profile fields of every listed Member in one pass. The returned lookup never
 * fails and never returns an empty `displayName`: a Member without a row or a name reads as
 * "Former member". Callers MUST pass only Members their viewer may already see.
 */
export const loadMemberSummaries = async (
  memberIds: readonly string[]
): Promise<(memberId: string) => MemberSummary> => {
  const ids = [...new Set(memberIds)];
  const summaries = new Map<string, MemberSummary>();
  if (ids.length > 0) {
    const [rows, ratings] = await Promise.all([
      db
        .select({
          id: authUser.id,
          firstName: authUser.firstName,
          lastName: authUser.lastName,
          departmentName: department.name,
          facultyName: faculty.name,
          avatarFileId: file.id,
          avatarBucket: file.bucket,
          avatarObjectKey: file.objectKey,
        })
        .from(authUser)
        .leftJoin(department, eq(authUser.departmentId, department.id))
        .leftJoin(faculty, eq(department.facultyId, faculty.id))
        .leftJoin(file, and(eq(authUser.imageFileId, file.id), isNull(file.deletedAt)))
        .where(inArray(authUser.id, ids)),
      Promise.all(ids.map((id) => getReceivedRatings(id))),
    ]);
    const ratingsById = new Map(ids.map((id, index) => [id, ratings[index] ?? []]));
    for (const row of rows) {
      const received = ratingsById.get(row.id) ?? [];
      summaries.set(row.id, {
        id: row.id,
        displayName: `${row.firstName} ${row.lastName}`.trim() || formerMemberName,
        avatar: toWorkChatAvatar(row),
        faculty: row.facultyName,
        department: row.departmentName,
        ratingAverage:
          received.length === 0
            ? null
            : received.reduce((sum, rating) => sum + rating, 0) / received.length,
      });
    }
  }
  return (memberId) => summaries.get(memberId) ?? formerMember(memberId);
};
