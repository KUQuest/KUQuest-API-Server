export const otherQuestTagName = 'Other';

export const fixedTagNames = [
  'Cleaning',
  'Delivery',
  'Fixing',
  'Teaching',
  'Sport',
  'Game/Activity',
  'Work/Homework',
  'Food and Drinks',
  'Pet',
  'Design',
  'Photography',
  otherQuestTagName,
] as const;

export type FixedTagName = (typeof fixedTagNames)[number];
