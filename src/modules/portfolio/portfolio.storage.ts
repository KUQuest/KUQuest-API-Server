import type { StoredImage } from '@/shared/image-storage';
import { createImageStorage } from '@/shared/image-storage';

export type StoredPortfolioImage = StoredImage;

export const portfolioStorage = createImageStorage({
  keyPrefix: 'portfolio',
  tooLargeMessage: 'Each image must be 5 MB or smaller',
});
