export type TeamRewardShare = {
  memberId: string;
  percentageBasisPoints: number;
};

export type TeamRewardAmount = TeamRewardShare & {
  rewardSatang: number;
  platformFeeSatang: number;
};

/** Split an integer amount by integer weights. Ties go to earlier input rows. */
const splitIntegerAmount = (total: number, weights: readonly number[]): number[] => {
  if (!Number.isSafeInteger(total) || total < 0) throw new Error('Invalid allocation total');
  const weightTotal = weights.reduce((sum, value) => sum + value, 0);
  if (!Number.isSafeInteger(weightTotal) || weightTotal <= 0) {
    throw new Error('Invalid allocation weights');
  }
  const numerators = weights.map((weight) => total * weight);
  if (numerators.some((value) => !Number.isSafeInteger(value))) {
    throw new Error('Allocation arithmetic exceeds safe integer range');
  }
  const amounts = numerators.map((value) => Math.floor(value / weightTotal));
  let remainder = total - amounts.reduce((sum, value) => sum + value, 0);
  const order = numerators
    .map((value, index) => ({ index, remainder: value % weightTotal }))
    .sort((left, right) => right.remainder - left.remainder || left.index - right.index);
  for (const { index } of order) {
    if (remainder === 0) break;
    if (weights[index] > 0) {
      amounts[index] += 1;
      remainder -= 1;
    }
  }
  if (remainder !== 0) throw new Error('Allocation remainder could not be distributed');
  return amounts;
};

/** Distribute the published team pool and fee exactly, with no floating-point money math. */
export const calculateTeamRewardAmounts = (
  totalRewardSatang: number,
  totalPlatformFeeSatang: number,
  shares: readonly TeamRewardShare[]
): TeamRewardAmount[] => {
  if (
    shares.length === 0 ||
    shares.reduce((sum, share) => sum + share.percentageBasisPoints, 0) !== 10_000
  ) {
    throw new Error('Team allocation must total 10000 basis points');
  }
  const rewardAmounts = splitIntegerAmount(
    totalRewardSatang,
    shares.map(({ percentageBasisPoints }) => percentageBasisPoints)
  );
  const feeAmounts = splitIntegerAmount(totalPlatformFeeSatang, rewardAmounts);
  return shares.map((share, index) => ({
    ...share,
    rewardSatang: rewardAmounts[index],
    platformFeeSatang: feeAmounts[index],
  }));
};

/** Equal allocation used when the Leader's 24-hour allocation window expires. */
export const equalTeamRewardShares = (memberIds: readonly string[]): TeamRewardShare[] => {
  if (memberIds.length === 0) throw new Error('A team must contain at least one member');
  const base = Math.floor(10_000 / memberIds.length);
  const remainder = 10_000 % memberIds.length;
  return memberIds.map((memberId, index) => ({
    memberId,
    percentageBasisPoints: base + (index < remainder ? 1 : 0),
  }));
};

/** The Leader receives the percentage left after all teammate shares are entered. */
export const sharesWithLeaderRemainder = (
  leaderId: string,
  teammateShares: readonly TeamRewardShare[],
  teamMemberIds: readonly string[]
): TeamRewardShare[] => {
  const members = new Set(teamMemberIds);
  if (!members.has(leaderId) || teamMemberIds.length !== members.size) {
    throw new Error('Candidate Team membership is invalid');
  }
  const seen = new Set<string>([leaderId]);
  let teammateBasisPoints = 0;
  for (const share of teammateShares) {
    if (
      !members.has(share.memberId) ||
      seen.has(share.memberId) ||
      !Number.isInteger(share.percentageBasisPoints) ||
      share.percentageBasisPoints < 0 ||
      share.percentageBasisPoints > 10_000
    ) {
      throw new Error('Candidate Team percentages are invalid');
    }
    seen.add(share.memberId);
    teammateBasisPoints += share.percentageBasisPoints;
  }
  if (seen.size !== members.size || teammateBasisPoints > 10_000) {
    throw new Error('Candidate Team percentages are incomplete or exceed 100 percent');
  }
  return teamMemberIds.map((memberId) => ({
    memberId,
    percentageBasisPoints:
      memberId === leaderId
        ? 10_000 - teammateBasisPoints
        : teammateShares.find((share) => share.memberId === memberId)!.percentageBasisPoints,
  }));
};
