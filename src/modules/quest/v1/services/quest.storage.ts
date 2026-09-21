import { createObjectStorage, type StoredImage } from '@/shared/object-storage';

export type StoredQuestImage = StoredImage;

export const questStorage = createObjectStorage({
  keyPrefix: 'quests',
  logLabel: 'quest-image-upload',
});
