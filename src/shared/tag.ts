export const otherQuestTagName = 'อื่นๆ (ETC.)';

export const fixedTagNames = [
  'ทำความสะอาด (Cleaning)',
  'ส่งของ (Delivery)',
  'ซ่อมแซม (Fixing)',
  'สอนหนังสือ (Teaching)',
  'กีฬา (Sport)',
  'เกมและสันทนาการ (Game/Activity)',
  'งานและการบ้าน (Work/Homework)',
  'อาหารและเครื่องดื่ม (Food and Drinks)',
  'สัตว์เลี้ยง (Pet)',
  'ออกแบบ (Design)',
  'ถ่ายภาพ (Photography)',
  otherQuestTagName,
] as const;

export type FixedTagName = (typeof fixedTagNames)[number];
