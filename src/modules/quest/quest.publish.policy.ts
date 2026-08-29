import {
  addSatang,
  calculatePlatformFeeSatang,
  satang,
  type Satang,
} from '@/modules/wallet';

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
  platformFeeBps: number;
  policyRevisionId?: string;
  policyRevision?: number;
  now: Date;
};

export type QuestPublishCheck = {
  blockingReasons: QuestPublishReason[];
  warnings: QuestPublishReason[];
  escrowRequirement: number;
  escrowRequirementSatang: number;
  platformFeeBps: number;
  platformFeePerWorkerSatang: number;
  policyRevisionId?: string;
  policyRevision?: number;
  canPublish: boolean;
};

const estimatedDurationMinutes = (startTime: Date, dueAt: Date | null) => {
  if (!dueAt || dueAt <= startTime) return null;

  return Math.max(1, Math.round((dueAt.getTime() - startTime.getTime()) / 60_000));
};

export const calculateQuestEscrowRequirementSatang = (
  snapshot: QuestPublishSnapshot,
): Satang => {
  const rewardSatang = satang(snapshot.rewardSatang);
  let rewardTotalSatang = satang(0);
  for (let slot = 0; slot < snapshot.headcount; slot += 1) {
    rewardTotalSatang = addSatang(rewardTotalSatang, rewardSatang);
  }
  const platformFeePerWorkerSatang = calculatePlatformFeeSatang(
    rewardSatang,
    snapshot.platformFeeBps,
  );
  let platformFeeSatang = satang(0);
  for (let slot = 0; slot < snapshot.headcount; slot += 1) {
    platformFeeSatang = addSatang(platformFeeSatang, platformFeePerWorkerSatang);
  }

  return addSatang(rewardTotalSatang, platformFeeSatang);
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

  const escrowRequirementSatang = calculateQuestEscrowRequirementSatang(snapshot);
  const platformFeePerWorkerSatang = calculatePlatformFeeSatang(
    satang(snapshot.rewardSatang),
    snapshot.platformFeeBps,
  );

  return {
    blockingReasons,
    warnings,
    escrowRequirement: Math.trunc(escrowRequirementSatang / 100),
    escrowRequirementSatang,
    platformFeeBps: snapshot.platformFeeBps,
    platformFeePerWorkerSatang,
    ...(snapshot.policyRevisionId ? { policyRevisionId: snapshot.policyRevisionId } : {}),
    ...(snapshot.policyRevision !== undefined ? { policyRevision: snapshot.policyRevision } : {}),
    canPublish: blockingReasons.length === 0,
  };
};
