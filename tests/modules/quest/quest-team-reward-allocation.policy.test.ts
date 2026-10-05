import { describe, expect, it } from 'bun:test';

import {
  calculateTeamRewardAmounts,
  equalTeamRewardShares,
  sharesWithLeaderRemainder,
} from '@/modules/quest/settlement/quest-team-reward-allocation';
import { isReadableCandidateTeamRoster } from '@/modules/quest/v2/shared/candidate-roster-access.policy';

describe('Candidate Team reward allocation policy', () => {
  it('gives the Leader the unassigned remainder and rejects missing, duplicate, or excessive shares', () => {
    const ids = ['leader', 'member-a', 'member-b'];
    expect(
      sharesWithLeaderRemainder(
        'leader',
        [
          { memberId: 'member-a', percentageBasisPoints: 2500 },
          { memberId: 'member-b', percentageBasisPoints: 1250 },
        ],
        ids
      )
    ).toEqual([
      { memberId: 'leader', percentageBasisPoints: 6250 },
      { memberId: 'member-a', percentageBasisPoints: 2500 },
      { memberId: 'member-b', percentageBasisPoints: 1250 },
    ]);
    expect(() => sharesWithLeaderRemainder('leader', [], ids)).toThrow();
    expect(() =>
      sharesWithLeaderRemainder(
        'leader',
        [
          { memberId: 'member-a', percentageBasisPoints: 6000 },
          { memberId: 'member-b', percentageBasisPoints: 5000 },
        ],
        ids
      )
    ).toThrow();
    expect(() =>
      sharesWithLeaderRemainder(
        'leader',
        [
          { memberId: 'member-a', percentageBasisPoints: 100 },
          { memberId: 'member-a', percentageBasisPoints: 100 },
        ],
        ids
      )
    ).toThrow();
  });

  it('splits reward and fee satang exactly with stable largest-remainder ties', () => {
    expect(
      calculateTeamRewardAmounts(101, 7, [
        { memberId: 'leader', percentageBasisPoints: 3334 },
        { memberId: 'member-a', percentageBasisPoints: 3333 },
        { memberId: 'member-b', percentageBasisPoints: 3333 },
      ])
    ).toEqual([
      { memberId: 'leader', percentageBasisPoints: 3334, rewardSatang: 34, platformFeeSatang: 3 },
      { memberId: 'member-a', percentageBasisPoints: 3333, rewardSatang: 34, platformFeeSatang: 2 },
      { memberId: 'member-b', percentageBasisPoints: 3333, rewardSatang: 33, platformFeeSatang: 2 },
    ]);
  });

  it('creates equal timeout shares whose integer basis points total exactly 100 percent', () => {
    const shares = equalTeamRewardShares(['leader', 'a', 'b']);
    expect(shares.map(({ percentageBasisPoints }) => percentageBasisPoints)).toEqual([
      3334, 3333, 3333,
    ]);
    expect(shares.reduce((sum, share) => sum + share.percentageBasisPoints, 0)).toBe(10_000);
  });

  it('keeps only the selected Candidate Team roster readable through completion', () => {
    const selectedTeamQuest = {
      v2Mode: 'CANDIDATE',
      v2Participation: 'GROUP',
      questState: 'QUEST_COMPLETED',
    };
    expect(isReadableCandidateTeamRoster(selectedTeamQuest)).toBe(true);
    expect(
      isReadableCandidateTeamRoster({ ...selectedTeamQuest, questState: 'QUEST_FAILED' })
    ).toBe(false);
    expect(isReadableCandidateTeamRoster({ ...selectedTeamQuest, v2Participation: 'SINGLE' })).toBe(
      false
    );
  });
});
