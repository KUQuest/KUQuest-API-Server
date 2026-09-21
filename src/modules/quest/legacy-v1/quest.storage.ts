import { createObjectStorage, type StoredImage } from '@/shared/object-storage';

export type StoredQuestImage = StoredImage;

export const questStorage = createObjectStorage({
  keyPrefix: 'quests',
  logLabel: 'quest-image-upload',
});

export const questV2Storage = createObjectStorage({
  keyPrefix: 'quests/v2',
  logLabel: 'quest-v2-image-upload',
});
