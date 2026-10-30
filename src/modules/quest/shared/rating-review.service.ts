import { db } from '@/database/client';
import { quest, questAssignment, review } from '@/database/schema/quest.schema';

import { and, eq, exists, inArray, or } from 'drizzle-orm';

import { terminalQuestStatuses } from './contracts/quest.contract';

/** Build the database filter for Reviews received by a Member. */
export const validReceivedReviewFilter = (memberId: string) =>
  and(
    inArray(quest.questStatus, terminalQuestStatuses),
    eq(review.revieweeId, memberId),
    or(
      and(
        eq(review.reviewerId, quest.hirerId),
        exists(
          db
            .select({ id: questAssignment.id })
            .from(questAssignment)
            .where(
              and(
                eq(questAssignment.questId, review.questId),
                eq(questAssignment.workerId, review.revieweeId)
              )
            )
        )
      ),
      and(
        eq(review.revieweeId, quest.hirerId),
        exists(
          db
            .select({ id: questAssignment.id })
            .from(questAssignment)
            .where(
              and(
                eq(questAssignment.questId, review.questId),
                eq(questAssignment.workerId, review.reviewerId)
              )
            )
        )
      )
    )
  );
