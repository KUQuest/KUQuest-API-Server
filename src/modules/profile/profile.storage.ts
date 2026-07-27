import { env } from '@/config/env';

import sharp from 'sharp';

const maxAvatarSizeBytes = 5 * 1024 * 1024;
const maxAvatarPixels = 25_000_000;

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
  if (avatar.size === 0) {
    throw new UnsupportedAvatarTypeError('Avatar file is empty');
  }
  if (avatar.size > maxAvatarSizeBytes) {
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
    throw new UnsupportedAvatarTypeError('Avatar must be a valid JPEG, PNG, or WebP image');
  }

  if (!contentType || avatar.type !== contentType) {
    throw new UnsupportedAvatarTypeError('Avatar must be a valid JPEG, PNG, or WebP image');
  }

  const bucket = env.s3Bucket;
  if (!bucket) throw new AvatarUploadError('S3 bucket is not configured');

  const objectKey = `avatars/${userId}/${crypto.randomUUID()}.${extensionByContentType[contentType]}`;

  try {
    const writtenBytes = await s3.write(objectKey, avatar, { type: contentType });
    if (writtenBytes !== avatar.size) {
      throw new Error(`Expected ${avatar.size} bytes but wrote ${writtenBytes}`);
    }
  } catch (error) {
    throw new AvatarUploadError('Avatar upload failed', { cause: error });
  }

  return {
    bucket,
    objectKey,
    contentType,
    sizeBytes: avatar.size,
  };
};

const deleteAvatar = async (bucket: string, objectKey: string): Promise<void> =>
  s3.delete(objectKey, { bucket });

export const avatarStorage = {
  delete: deleteAvatar,
  upload: uploadAvatar,
};
