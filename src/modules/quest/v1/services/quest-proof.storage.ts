import { createObjectStorage, type StoredImage } from '@/shared/object-storage';

export type StoredProofImage = StoredImage;

export const proofStorage = createObjectStorage({
  keyPrefix: 'proofs',
  logLabel: 'proof-image-upload',
});
