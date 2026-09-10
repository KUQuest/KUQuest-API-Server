import { db } from '@/database/client';
import { questEditHistory } from '@/database/schema/quest.schema';

type QuestTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** One field change to append to the Quest edit history. */
export type QuestEditHistoryEntry = {
  fieldName: string;
  oldValue: unknown;
  newValue: unknown;
};

export type QuestEditHistoryInput = {
  questId: string;
  entries: QuestEditHistoryEntry[];
  editedAt: Date;
  /** The Member who made the change. Use `editedByAdminId` for an Admin action. */
  editedByUserId?: string | null;
  editedByAdminId?: string | null;
  /** The v2 Quest Edit that applied the change, when the change came from one. */
  v2EditRequestId?: string | null;
};

/**
 * Appends Quest edit history rows. The history is append only; a caller must
 * never update or delete a row. An entry whose old value equals its new value
 * is dropped, so an unchanged field creates no row.
 */
export const recordQuestEditHistory = async (
  transaction: QuestTransaction,
  input: QuestEditHistoryInput,
): Promise<void> => {
  const changed = input.entries.filter(
    (entry) => !isSameValue(entry.oldValue, entry.newValue),
  );
  if (changed.length === 0) return;

  await transaction.insert(questEditHistory).values(
    changed.map((entry) => ({
      questId: input.questId,
      v2EditRequestId: input.v2EditRequestId ?? null,
      fieldName: entry.fieldName,
      oldValue: toJsonValue(entry.oldValue),
      newValue: toJsonValue(entry.newValue),
      editedAt: input.editedAt,
      editedByUserId: input.editedByUserId ?? null,
      editedByAdminId: input.editedByAdminId ?? null,
    })),
  );
};

/** Converts a value to the shape the `jsonb` columns keep. */
const toJsonValue = (value: unknown): unknown => {
  if (value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return value;
};

const isSameValue = (left: unknown, right: unknown): boolean =>
  JSON.stringify(toJsonValue(left)) === JSON.stringify(toJsonValue(right));
