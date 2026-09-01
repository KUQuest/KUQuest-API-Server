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

export const isValidQuestV2Headcount = (
  participation: QuestV2Participation,
  headcount: number,
): boolean => {
  if (!Number.isInteger(headcount) || headcount < 1 || headcount > 20) return false;
  return participation === questV2Participation.single ? headcount === 1 : headcount >= 2;
};

export const questV2ScheduleTimePattern =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?\+07:00$/;
export const questV2CanonicalScheduleTimePattern =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}\+07:00$/;

export const isQuestV2ScheduleTime = (value: string): boolean =>
  questV2ScheduleTimePattern.test(value) && !Number.isNaN(new Date(value).getTime());

export const formatQuestV2ScheduleTime = (value: Date): string => {
  const bangkokTime = new Date(value.getTime() + 7 * 60 * 60 * 1000);
  return `${bangkokTime.toISOString().slice(0, -1)}+07:00`;
};

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
