import { env } from '@/config/env';

const MAX_AVATAR_SIZE_BYTES = 5 * 1024 * 1024;

const extensionByContentType = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
} as const;

type AvatarContentType = keyof typeof extensionByContentType;

export class AvatarTooLargeError extends Error {}
export class UnsupportedAvatarTypeError extends Error {}
export class AvatarUploadError extends Error {}

const hasBytes = (bytes: Uint8Array, expected: number[], offset = 0): boolean =>
  expected.every((value, index) => bytes[offset + index] === value);

const detectAvatarContentType = (bytes: Uint8Array): AvatarContentType | undefined => {
  if (hasBytes(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (hasBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return 'image/png';
  }
  if (
    hasBytes(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    hasBytes(bytes, [0x57, 0x45, 0x42, 0x50], 8)
  ) {
    return 'image/webp';
  }
};

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
  if (avatar.size > MAX_AVATAR_SIZE_BYTES) {
    throw new AvatarTooLargeError('Avatar must be 5 MB or smaller');
  }

  const header = new Uint8Array(await avatar.slice(0, 12).arrayBuffer());
  const contentType = detectAvatarContentType(header);

  if (!contentType || avatar.type !== contentType) {
    throw new UnsupportedAvatarTypeError('Avatar must be a JPEG, PNG, or WebP image');
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

const deleteAvatar = async (objectKey: string): Promise<void> => {
  try {
    await s3.delete(objectKey);
  } catch {
    // Compensation is best-effort. The object is unreferenced if persistence failed.
  }
};

export const avatarStorage = {
  delete: deleteAvatar,
  upload: uploadAvatar,
};
