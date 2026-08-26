export type QuestPublishReason = {
  code: string;
  message: string;
};

export type QuestPublishSnapshot = {
  tagId: string | null;
  startTime: Date;
  dueAt: Date | null;
  hasImages: boolean;
  hasLocations: boolean;
  rewardSatang: number;
  headcount: number;
  now: Date;
};

export type QuestPublishCheck = {
  blockingReasons: QuestPublishReason[];
  warnings: QuestPublishReason[];
  escrowRequirement: number;
  canPublish: boolean;
};

const estimatedDurationMinutes = (startTime: Date, dueAt: Date | null) => {
  if (!dueAt || dueAt <= startTime) return null;

  return Math.max(1, Math.round((dueAt.getTime() - startTime.getTime()) / 60_000));
};

export const buildQuestPublishCheck = (
  snapshot: QuestPublishSnapshot,
): QuestPublishCheck => {
  const blockingReasons: QuestPublishReason[] = [];
  const warnings: QuestPublishReason[] = [];

  if (!snapshot.tagId) {
    blockingReasons.push({
      code: 'QUEST_TAG_REQUIRED',
      message: 'Quest requires a Tag',
    });
  }

  if (estimatedDurationMinutes(snapshot.startTime, snapshot.dueAt) === null) {
    blockingReasons.push({
      code: 'QUEST_DURATION_REQUIRED',
      message: 'Quest requires an estimated duration',
    });
  }

  if (snapshot.startTime <= snapshot.now) {
    blockingReasons.push({
      code: 'QUEST_START_TIME_NOT_IN_FUTURE',
      message: 'Quest startTime must be in the future',
    });
  }

  if (!snapshot.hasImages) {
    warnings.push({
      code: 'QUEST_IMAGES_MISSING',
      message: 'Quest has no images',
    });
  }

  if (!snapshot.hasLocations) {
    warnings.push({
      code: 'QUEST_LOCATIONS_MISSING',
      message: 'Quest has no locations',
    });
  }

  return {
    blockingReasons,
    warnings,
    escrowRequirement: Math.trunc(snapshot.rewardSatang / 100) * snapshot.headcount,
    canPublish: blockingReasons.length === 0,
  };
};
