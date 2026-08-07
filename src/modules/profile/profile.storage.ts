import type { StoredImage } from '@/shared/image-storage';
import { createImageStorage } from '@/shared/image-storage';

export type StoredAvatar = StoredImage;

export const avatarStorage = createImageStorage({
  keyPrefix: 'avatars',
  logLabel: 'avatar-upload',
  emptyFileMessage: 'Avatar file is empty',
  tooLargeMessage: 'Avatar must be 5 MB or smaller',
  unsupportedTypeMessage: 'Avatar must be a valid JPEG, PNG, or WebP image',
});
