import type { StoredImage } from '@/shared/image-storage';
import { createImageStorage } from '@/shared/image-storage';

export type StoredProofImage = StoredImage;

export const proofStorage = createImageStorage({
  keyPrefix: 'proofs',
  logLabel: 'proof-image-upload',
});
