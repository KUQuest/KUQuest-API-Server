import { env } from '@/config/env';

import sharp from 'sharp';

const extensionByContentType = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
} as const;

const contentTypeByFormat = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
} as const;

export type ImageContentType = keyof typeof extensionByContentType;

export type StoredImage = {
  bucket: string;
  objectKey: string;
  contentType: ImageContentType;
  sizeBytes: number;
};

export class ImageTooLargeError extends Error {}
export class UnsupportedImageTypeError extends Error {}
export class ImageUploadError extends Error {}
export class ImageLinkUnavailableError extends Error {}

export const createDebugLogger =
  (label: string) =>
  (message: string, details?: unknown): void => {
    if (env.nodeEnv !== 'test') {
      console.info(`[${label}] ${message}`, details ?? '');
    }
  };

const maxImagePixels = 25_000_000;
const defaultMaxSizeBytes = 5 * 1024 * 1024;
const defaultUrlLifetimeSeconds = 15 * 60;

type ImageStorageConfig = {
  keyPrefix: string;
  logLabel?: string;
  maxSizeBytes?: number;
  urlLifetimeSeconds?: number;
  emptyFileMessage?: string;
  tooLargeMessage?: string;
  unsupportedTypeMessage?: string;
};

export const createImageStorage = ({
  keyPrefix,
  logLabel = `${keyPrefix}-upload`,
  maxSizeBytes = defaultMaxSizeBytes,
  urlLifetimeSeconds = defaultUrlLifetimeSeconds,
  emptyFileMessage = 'Image file is empty',
  tooLargeMessage = `Image must be ${Math.floor(maxSizeBytes / (1024 * 1024))} MB or smaller`,
  unsupportedTypeMessage = 'Image must be a valid JPEG, PNG, or WebP file',
}: ImageStorageConfig) => {
  const log = createDebugLogger(logLabel);

  const s3 = new Bun.S3Client({
    accessKeyId: env.s3AccessKeyId,
    secretAccessKey: env.s3SecretAccessKey,
    bucket: env.s3Bucket,
    endpoint: env.s3Endpoint,
    region: env.s3Region,
  });

  const upload = async (userId: string, image: File): Promise<StoredImage> => {
    log('Validating file', {
      declaredContentType: image.type,
      sizeBytes: image.size,
      userId,
    });

    if (image.size === 0) {
      throw new UnsupportedImageTypeError(emptyFileMessage);
    }
    if (image.size > maxSizeBytes) {
      throw new ImageTooLargeError(tooLargeMessage);
    }

    const bytes = new Uint8Array(await image.arrayBuffer());
    let contentType: ImageContentType | undefined;

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
      throw new UnsupportedImageTypeError(unsupportedTypeMessage);
    }

    if (!contentType || image.type !== contentType) {
      throw new UnsupportedImageTypeError(unsupportedTypeMessage);
    }

    const bucket = env.s3Bucket;
    if (!bucket) {
      throw new ImageUploadError('S3 bucket is not configured');
    }

    const objectKey = `${keyPrefix}/${userId}/${crypto.randomUUID()}.${extensionByContentType[contentType]}`;

    try {
      const writtenBytes = await s3.write(objectKey, image, { type: contentType });
      if (writtenBytes !== image.size) {
        throw new Error(`Expected ${image.size} bytes but wrote ${writtenBytes}`);
      }
    } catch (error) {
      console.error(`[${logLabel}] Upload failed`, { bucket, error, objectKey });
      throw new ImageUploadError('Image upload failed', { cause: error });
    }

    log('Upload succeeded', { bucket, objectKey, userId });

    return { bucket, objectKey, contentType, sizeBytes: image.size };
  };

  const deleteImage = async (bucket: string, objectKey: string): Promise<void> => {
    log('Deleting object', { bucket, objectKey });
    await s3.delete(objectKey, { bucket });
  };

  const linkFor = ({ bucket, objectKey }: Pick<StoredImage, 'bucket' | 'objectKey'>): string => {
    if (!env.s3AccessKeyId || !env.s3SecretAccessKey || !env.s3Endpoint || !env.s3Region) {
      throw new ImageLinkUnavailableError('Object storage is not configured');
    }

    return s3.presign(objectKey, { bucket, expiresIn: urlLifetimeSeconds });
  };

  return {
    delete: deleteImage,
    linkFor,
    upload,
  };
};
