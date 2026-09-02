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

const questV2BangkokOffsetMilliseconds = 7 * 60 * 60 * 1000;

export const isQuestV2ScheduleTime = (value: string): boolean => {
  if (!questV2ScheduleTimePattern.test(value)) return false;

  const [datePart, timePart] = value.slice(0, -6).split('T');
  if (!datePart || !timePart) return false;

  const [yearText, monthText, dayText] = datePart.split('-');
  const [hourText, minuteText, secondAndFraction] = timePart.split(':');
  if (!yearText || !monthText || !dayText || !hourText || !minuteText || !secondAndFraction) {
    return false;
  }

  const [secondText, fractionText] = secondAndFraction.split('.');
  if (!secondText) return false;

  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const milliseconds = Number((fractionText ?? '').padEnd(3, '0'));
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return false;
  }

  const localTime = new Date(0);
  localTime.setUTCFullYear(year, month - 1, day);
  localTime.setUTCHours(hour, minute, second, milliseconds);
  if (
    localTime.getUTCFullYear() !== year ||
    localTime.getUTCMonth() !== month - 1 ||
    localTime.getUTCDate() !== day ||
    localTime.getUTCHours() !== hour ||
    localTime.getUTCMinutes() !== minute ||
    localTime.getUTCSeconds() !== second ||
    localTime.getUTCMilliseconds() !== milliseconds
  ) {
    return false;
  }

  const parsed = new Date(value);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.getTime() === localTime.getTime() - questV2BangkokOffsetMilliseconds
  );
};

export const formatQuestV2ScheduleTime = (value: Date): string => {
  const bangkokTime = new Date(value.getTime() + questV2BangkokOffsetMilliseconds);
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

export const questV2AssignmentStates = [
  'ASSIGNMENT_ACTIVE',
  'ASSIGNMENT_COMPLETED',
  'ASSIGNMENT_INCOMPLETE',
  'ASSIGNMENT_CANCELLED',
] as const;
export type QuestV2AssignmentState = (typeof questV2AssignmentStates)[number];

export const questV2ApplicationStates = [
  'APPLICATION_APPLIED',
  'APPLICATION_SELECTED',
  'APPLICATION_REJECTED',
  'APPLICATION_WITHDRAWN',
] as const;
export type QuestV2ApplicationState = (typeof questV2ApplicationStates)[number];

export const questV2EditRequestStatuses = [
  'EDIT_REQUEST_PENDING',
  'EDIT_REQUEST_APPLIED',
  'EDIT_REQUEST_FAILED',
] as const;
export type QuestV2EditRequestStatus = (typeof questV2EditRequestStatuses)[number];

export const questV2EditResponseDecisions = [
  'EDIT_RESPONSE_ACCEPTED',
  'EDIT_RESPONSE_DECLINED',
] as const;
export type QuestV2EditResponseDecision = (typeof questV2EditResponseDecisions)[number];

export const questV2EditFailureCodes = [
  'EDIT_REQUEST_DECLINED',
  'EDIT_REQUEST_TIMEOUT',
  'ACTIVE_WORKER_LEFT',
] as const;
export type QuestV2EditFailureCode = (typeof questV2EditFailureCodes)[number];

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
