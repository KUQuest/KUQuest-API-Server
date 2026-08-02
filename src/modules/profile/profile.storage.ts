import { env } from '@/config/env';

import sharp from 'sharp';

const maxAvatarSizeBytes = 5 * 1024 * 1024;
const maxAvatarPixels = 25_000_000;

const debugAvatarUpload = (message: string, details?: unknown): void => {
  if (env.nodeEnv !== 'test') {
    console.info(`[avatar-upload] ${message}`, details ?? '');
  }
};

const extensionByContentType = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
} as const;

type AvatarContentType = keyof typeof extensionByContentType;

export class AvatarTooLargeError extends Error {}
export class UnsupportedAvatarTypeError extends Error {}
export class AvatarUploadError extends Error {}

const contentTypeByFormat = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
} as const;

const s3 = new Bun.S3Client({
  accessKeyId: env.s3AccessKeyId,
  secretAccessKey: env.s3SecretAccessKey,
  bucket: env.s3Bucket,
  endpoint: env.s3Endpoint,
  region: env.s3Region,
});

export type StoredAvatar = {
  bucket: string;
  objectKey: string;
  contentType: AvatarContentType;
  sizeBytes: number;
};

const uploadAvatar = async (userId: string, avatar: File): Promise<StoredAvatar> => {
  debugAvatarUpload('Validating file', {
    declaredContentType: avatar.type,
    sizeBytes: avatar.size,
    userId,
  });

  if (avatar.size === 0) {
    debugAvatarUpload('Rejected empty file', { userId });
    throw new UnsupportedAvatarTypeError('Avatar file is empty');
  }
  if (avatar.size > maxAvatarSizeBytes) {
    debugAvatarUpload('Rejected oversized file', {
      maxAvatarSizeBytes,
      sizeBytes: avatar.size,
      userId,
    });
    throw new AvatarTooLargeError('Avatar must be 5 MB or smaller');
  }

  const bytes = new Uint8Array(await avatar.arrayBuffer());
  let contentType: AvatarContentType | undefined;

  try {
    const image = sharp(bytes, {
      failOn: 'warning',
      limitInputPixels: maxAvatarPixels,
    });
    const metadata = await image.metadata();
    contentType = metadata.format
      ? contentTypeByFormat[metadata.format as keyof typeof contentTypeByFormat]
      : undefined;
    await image.clone().raw().toBuffer();
  } catch {
    debugAvatarUpload('Decoder rejected file', {
      declaredContentType: avatar.type,
      sizeBytes: avatar.size,
      userId,
    });
    throw new UnsupportedAvatarTypeError('Avatar must be a valid JPEG, PNG, or WebP image');
  }

  if (!contentType || avatar.type !== contentType) {
    debugAvatarUpload('Rejected content-type mismatch', {
      declaredContentType: avatar.type,
      detectedContentType: contentType,
      userId,
    });
    throw new UnsupportedAvatarTypeError('Avatar must be a valid JPEG, PNG, or WebP image');
  }

  const bucket = env.s3Bucket;
  if (!bucket) {
    debugAvatarUpload('RustFS bucket is not configured');
    throw new AvatarUploadError('S3 bucket is not configured');
  }

  const objectKey = `avatars/${userId}/${crypto.randomUUID()}.${extensionByContentType[contentType]}`;

  try {
    debugAvatarUpload('Writing object to RustFS', {
      bucket,
      contentType,
      endpoint: env.s3Endpoint,
      objectKey,
      region: env.s3Region,
      sizeBytes: avatar.size,
    });
    const writtenBytes = await s3.write(objectKey, avatar, { type: contentType });
    if (writtenBytes !== avatar.size) {
      throw new Error(`Expected ${avatar.size} bytes but wrote ${writtenBytes}`);
    }
    debugAvatarUpload('RustFS write succeeded', {
      bucket,
      objectKey,
      writtenBytes,
    });
  } catch (error) {
    console.error('[avatar-upload] RustFS write failed', {
      bucket,
      endpoint: env.s3Endpoint,
      error,
      objectKey,
      region: env.s3Region,
    });
    throw new AvatarUploadError('Avatar upload failed', { cause: error });
  }

  return {
    bucket,
    objectKey,
    contentType,
    sizeBytes: avatar.size,
  };
};

const deleteAvatar = async (bucket: string, objectKey: string): Promise<void> => {
  debugAvatarUpload('Deleting object from RustFS', { bucket, objectKey });
  await s3.delete(objectKey, { bucket });
  debugAvatarUpload('RustFS delete succeeded', { bucket, objectKey });
};

const avatarUrlLifetimeSeconds = 15 * 60;

export class AvatarLinkUnavailableError extends Error {}

const linkForAvatar = ({ bucket, objectKey }: Pick<StoredAvatar, 'bucket' | 'objectKey'>): string => {
  if (!env.s3AccessKeyId || !env.s3SecretAccessKey || !env.s3Endpoint || !env.s3Region) {
    throw new AvatarLinkUnavailableError('Object storage is not configured');
  }

  return s3.presign(objectKey, { bucket, expiresIn: avatarUrlLifetimeSeconds });
};

export const avatarStorage = {
  delete: deleteAvatar,
  linkFor: linkForAvatar,
  upload: uploadAvatar,
};
