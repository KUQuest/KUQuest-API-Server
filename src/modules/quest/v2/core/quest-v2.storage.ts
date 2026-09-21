import { createObjectStorage } from '@/shared/object-storage';

export const questV2Storage = createObjectStorage({
  keyPrefix: 'quests/v2',
  logLabel: 'quest-v2-image-upload',
});
