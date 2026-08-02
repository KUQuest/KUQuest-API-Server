import { env } from '@/config/env';
import sharp from 'sharp';

const maxImageSizeBytes = 5 * 1024 * 1024;
const maxImagePixels = 25_000_000;

const extensionByContentType = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
} as const;

type PortfolioImageContentType = keyof typeof extensionByContentType;

const contentTypeByFormat = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
} as const;

export class PortfolioImageTooLargeError extends Error {}
export class UnsupportedPortfolioImageTypeError extends Error {}
export class PortfolioImageUploadError extends Error {}
export class PortfolioLinkUnavailableError extends Error {}

const s3 = new Bun.S3Client({
  accessKeyId: env.s3AccessKeyId,
  secretAccessKey: env.s3SecretAccessKey,
  bucket: env.s3Bucket,
  endpoint: env.s3Endpoint,
  region: env.s3Region,
});

export type StoredPortfolioImage = {
  bucket: string;
  objectKey: string;
  contentType: PortfolioImageContentType;
  sizeBytes: number;
};

const uploadPortfolioImage = async (
  userId: string,
  image: File,
): Promise<StoredPortfolioImage> => {
  if (image.size === 0) {
    throw new UnsupportedPortfolioImageTypeError('Image file is empty');
  }
  if (image.size > maxImageSizeBytes) {
    throw new PortfolioImageTooLargeError('Each image must be 5 MB or smaller');
  }

  const bytes = new Uint8Array(await image.arrayBuffer());
  let contentType: PortfolioImageContentType | undefined;

  try {
    const decoded = sharp(bytes, {
      failOn: 'warning',
      limitInputPixels: maxImagePixels,
    });
    const metadata = await decoded.metadata();
    contentType = metadata.format
      ? contentTypeByFormat[metadata.format as keyof typeof contentTypeByFormat]
      : undefined;
    await decoded.clone().raw().toBuffer();
  } catch {
    throw new UnsupportedPortfolioImageTypeError('Image must be a valid JPEG, PNG, or WebP file');
  }

  if (!contentType || image.type !== contentType) {
    throw new UnsupportedPortfolioImageTypeError('Image must be a valid JPEG, PNG, or WebP file');
  }

  const bucket = env.s3Bucket;
  if (!bucket) {
    throw new PortfolioImageUploadError('S3 bucket is not configured');
  }

  const objectKey = `portfolio/${userId}/${crypto.randomUUID()}.${extensionByContentType[contentType]}`;

  try {
    const writtenBytes = await s3.write(objectKey, image, { type: contentType });
    if (writtenBytes !== image.size) {
      throw new Error(`Expected ${image.size} bytes but wrote ${writtenBytes}`);
    }
  } catch (error) {
    throw new PortfolioImageUploadError('Image upload failed', { cause: error });
  }

  return { bucket, objectKey, contentType, sizeBytes: image.size };
};

const deletePortfolioImage = async (bucket: string, objectKey: string): Promise<void> => {
  await s3.delete(objectKey, { bucket });
};

const portfolioImageUrlLifetimeSeconds = 15 * 60;

const linkForPortfolioImage = ({
  bucket,
  objectKey,
}: Pick<StoredPortfolioImage, 'bucket' | 'objectKey'>): string => {
  if (!env.s3AccessKeyId || !env.s3SecretAccessKey || !env.s3Endpoint || !env.s3Region) {
    throw new PortfolioLinkUnavailableError('Object storage is not configured');
  }

  return s3.presign(objectKey, { bucket, expiresIn: portfolioImageUrlLifetimeSeconds });
};

export const portfolioStorage = {
  delete: deletePortfolioImage,
  linkFor: linkForPortfolioImage,
  upload: uploadPortfolioImage,
};