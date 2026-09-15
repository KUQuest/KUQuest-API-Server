import type { StoredImage } from '@/shared/object-storage';
import { createObjectStorage } from '@/shared/object-storage';

export type StoredPortfolioImage = StoredImage;

export const portfolioStorage = createObjectStorage({
  policy: 'image-only',
  keyPrefix: 'portfolio',
  tooLargeMessage: 'Each image must be 5 MB or smaller',
});
