export const questV2Mode = {
  firstComeFirstServed: 'FIRST_COME_FIRST_SERVED',
  candidate: 'CANDIDATE',
} as const;
export const questV2Modes = [questV2Mode.firstComeFirstServed, questV2Mode.candidate] as const;
export type QuestV2Mode = (typeof questV2Modes)[number];

export const questV2Participation = {
  single: 'SINGLE',
  group: 'GROUP',
} as const;
export const questV2Participations = [
  questV2Participation.single,
  questV2Participation.group,
] as const;
export type QuestV2Participation = (typeof questV2Participations)[number];

export const questV2States = [
  'QUEST_DRAFT',
  'QUEST_OPEN',
  'QUEST_ASSIGNED',
  'QUEST_IN_PROGRESS',
  'QUEST_COMPLETED',
  'QUEST_CANCELLED',
  'QUEST_FAILED',
] as const;
export type QuestV2State = (typeof questV2States)[number];

export type QuestV2CanonicalQuest = {
  id: string;
  version: number;
  title: string;
  description: string | null;
  condition: {
    items: Array<{
      position: number;
      text: string;
    }>;
  };
  tag: { id: string; name: string } | null;
  mode: QuestV2Mode;
  participation: QuestV2Participation;
  state: QuestV2State;
  questFundingTotal: number;
  headcount: number;
  startTime: string;
  dueAt: string | null;
  proofRequired: boolean;
  locations: Array<{ label: string }>;
  createdAt: string;
  updatedAt: string;
};
