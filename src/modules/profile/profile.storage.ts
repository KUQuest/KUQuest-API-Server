import type { StoredImage } from '@/shared/object-storage';
import { createObjectStorage } from '@/shared/object-storage';

export type StoredAvatar = StoredImage;

export const avatarStorage = createObjectStorage({
  policy: 'image-only',
  keyPrefix: 'avatars',
  logLabel: 'avatar-upload',
  emptyFileMessage: 'Avatar file is empty',
  tooLargeMessage: 'Avatar must be 5 MB or smaller',
  unsupportedTypeMessage: 'Avatar must be a valid JPEG, PNG, or WebP image',
});
