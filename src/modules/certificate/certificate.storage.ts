import type { StoredImage } from '@/shared/image-storage';
import { createImageStorage } from '@/shared/image-storage';

export type StoredCertificateImage = StoredImage;

export const certificateStorage = createImageStorage({
  keyPrefix: 'certificates',
  logLabel: 'certificate-image-upload',
});
