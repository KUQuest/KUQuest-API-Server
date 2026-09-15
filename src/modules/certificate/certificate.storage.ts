import type { StoredImage } from '@/shared/object-storage';
import { createObjectStorage } from '@/shared/object-storage';

export type StoredCertificateImage = StoredImage;

export const certificateStorage = createObjectStorage({
  policy: 'image-only',
  keyPrefix: 'certificates',
  logLabel: 'certificate-image-upload',
});
