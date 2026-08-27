import type { StoredImage } from '@/shared/image-storage';
import { createImageStorage } from '@/shared/image-storage';

export type StoredQuestImage = StoredImage;

export const questStorage = createImageStorage({
  keyPrefix: 'quests',
  logLabel: 'quest-image-upload',
});
