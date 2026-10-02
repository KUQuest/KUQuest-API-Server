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

/** Localized display text; canonical English names remain stable database keys. */
export const fixedTagNamesTh: Record<FixedTagName, string> = {
  Cleaning: 'ทำความสะอาด',
  Delivery: 'ส่งของ',
  Fixing: 'ซ่อมแซม',
  Teaching: 'สอนหนังสือ',
  Sport: 'กีฬา',
  'Game/Activity': 'เกมและสันทนาการ',
  'Work/Homework': 'งานและการบ้าน',
  'Food and Drinks': 'อาหารและเครื่องดื่ม',
  Pet: 'สัตว์เลี้ยง',
  Design: 'ออกแบบ',
  Photography: 'ถ่ายภาพ',
  Other: 'อื่นๆ',
};
