import type { WalletStatus } from '@/database/schema/wallet.schema';
import { calculatePlatformFeeSatang, satang, type Satang } from '@/modules/wallet';

export type QuestV2PublishReason = {
  code: string;
  message: string;
};

export type QuestV2FundingQuoteInput = {
  questFundingTotalSatang: Satang;
  headcount: number;
  platformFeeBps: number;
  feeRoundingMode: 'UP';
  policyRevisionId: string;
  policyRevision: number;
};

export type QuestV2FundingQuote = {
  questFundingTotal: number;
  questFundingTotalSatang: Satang;
  questReward: number;
  questRewardSatang: Satang;
  platformFee: number;
  platformFeeSatang: Satang;
  escrowRequirement: number;
  escrowRequirementSatang: Satang;
  headcount: number;
  platformFeeBps: number;
  feeRoundingMode: 'UP';
  policyRevisionId: string;
  policyRevision: number;
};

export type QuestV2PublishSnapshot = QuestV2FundingQuoteInput & {
  tagId: string | null;
  conditionValid: boolean;
  startTime: Date;
  dueAt: Date | null;
  now: Date;
  spendingBalanceSatang: Satang;
  walletStatus: WalletStatus;
  minimumFundingReservationSatang: number;
  maximumFundingReservationSatang: number;
};

export type QuestV2PublishCheck = QuestV2FundingQuote & {
  blockingReasons: QuestV2PublishReason[];
  warnings: QuestV2PublishReason[];
  canPublish: boolean;
};

const toBaht = (amountSatang: Satang): number => Number((amountSatang / 100).toFixed(2));

const requiredFundingForReward = (rewardSatang: number, platformFeeBps: number) =>
  rewardSatang + calculatePlatformFeeSatang(satang(rewardSatang), platformFeeBps);

const greatestRewardSatang = (questFundingTotalSatang: Satang, platformFeeBps: number): Satang => {
  let lowerBound = 0;
  let upperBound: number = questFundingTotalSatang;
  let greatestReward = 0;

  while (lowerBound <= upperBound) {
    const candidate = Math.floor((lowerBound + upperBound) / 2);
    if (requiredFundingForReward(candidate, platformFeeBps) <= questFundingTotalSatang) {
      greatestReward = candidate;
      lowerBound = candidate + 1;
    } else {
      upperBound = candidate - 1;
    }
  }

  return satang(greatestReward);
};

export const calculateQuestV2FundingQuote = (
  input: QuestV2FundingQuoteInput,
): QuestV2FundingQuote => {
  const questRewardSatang = greatestRewardSatang(
    input.questFundingTotalSatang,
    input.platformFeeBps,
  );
  const platformFeeSatang = satang(input.questFundingTotalSatang - questRewardSatang);
  const escrowRequirementSatang = satang(input.questFundingTotalSatang * input.headcount);

  return {
    questFundingTotal: toBaht(input.questFundingTotalSatang),
    questFundingTotalSatang: input.questFundingTotalSatang,
    questReward: toBaht(questRewardSatang),
    questRewardSatang,
    platformFee: toBaht(platformFeeSatang),
    platformFeeSatang,
    escrowRequirement: toBaht(escrowRequirementSatang),
    escrowRequirementSatang,
    headcount: input.headcount,
    platformFeeBps: input.platformFeeBps,
    feeRoundingMode: input.feeRoundingMode,
    policyRevisionId: input.policyRevisionId,
    policyRevision: input.policyRevision,
  };
};

export const buildQuestV2PublishCheck = (
  snapshot: QuestV2PublishSnapshot,
): QuestV2PublishCheck => {
  const quote = calculateQuestV2FundingQuote(snapshot);
  const blockingReasons: QuestV2PublishReason[] = [];

  if (!snapshot.tagId) {
    blockingReasons.push({
      code: 'QUEST_TAG_REQUIRED',
      message: 'Quest requires a Tag',
    });
  }

  if (!snapshot.conditionValid) {
    blockingReasons.push({
      code: 'QUEST_CONDITION_REQUIRED',
      message: 'Quest requires at least one Condition Item',
    });
  }

  if (!snapshot.dueAt) {
    blockingReasons.push({
      code: 'QUEST_DUE_AT_REQUIRED',
      message: 'Quest requires a dueAt',
    });
  } else if (Number.isNaN(snapshot.dueAt.getTime())) {
    blockingReasons.push({
      code: 'QUEST_DUE_AT_INVALID',
      message: 'Quest dueAt must be a valid date-time',
    });
  } else if (snapshot.dueAt <= snapshot.startTime) {
    blockingReasons.push({
      code: 'QUEST_DUE_AT_NOT_AFTER_START_TIME',
      message: 'Quest dueAt must be after startTime',
    });
  }

  if (Number.isNaN(snapshot.startTime.getTime()) || snapshot.startTime <= snapshot.now) {
    blockingReasons.push({
      code: 'QUEST_START_TIME_NOT_IN_FUTURE',
      message: 'Quest startTime must be in the future',
    });
  }

  if (snapshot.walletStatus !== 'ACTIVE') {
    blockingReasons.push({
      code: 'WALLET_NOT_ACTIVE',
      message: `Wallet status ${snapshot.walletStatus} does not permit FUNDING_RESERVATION.`,
    });
  }

  if (
    quote.escrowRequirementSatang < snapshot.minimumFundingReservationSatang ||
    quote.escrowRequirementSatang > snapshot.maximumFundingReservationSatang
  ) {
    blockingReasons.push({
      code: 'QUEST_ESCROW_AMOUNT_OUT_OF_RANGE',
      message: 'Quest Escrow amount is outside the active Money Policy limits',
    });
  }

  if (snapshot.spendingBalanceSatang < quote.escrowRequirementSatang) {
    blockingReasons.push({
      code: 'INSUFFICIENT_SPENDING_BALANCE',
      message: 'Spending Balance is insufficient for Quest Escrow',
    });
  }

  return {
    ...quote,
    blockingReasons,
    warnings: [],
    canPublish: blockingReasons.length === 0,
  };
};
