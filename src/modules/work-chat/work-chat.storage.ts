import { env } from '@/config/env';

import sharp from 'sharp';

const MAX_ATTACHMENT_SIZE_BYTES = 10 * 1024 * 1024;
const LINK_LIFETIME_SECONDS = 15 * 60;

const extensionByContentType = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
} as const;

export type WorkChatAttachmentContentType = keyof typeof extensionByContentType;

export type StoredWorkChatAttachment = {
  bucket: string;
  objectKey: string;
  contentType: WorkChatAttachmentContentType;
  sizeBytes: number;
};

export type WorkChatAttachmentLink = {
  url: string;
  expiresAt: Date;
};

export class WorkChatAttachmentTooLargeError extends Error {}
export class UnsupportedWorkChatAttachmentError extends Error {}
export class WorkChatAttachmentUploadError extends Error {}
export class WorkChatAttachmentLinkUnavailableError extends Error {}

type WorkChatStorageConfig = {
  keyPrefix: string;
  bucket?: string;
  client?: Pick<Bun.S3Client, 'write' | 'delete' | 'presign'>;
  maxSizeBytes?: number;
  urlLifetimeSeconds?: number;
};

const textAt = (bytes: Uint8Array, offset: number, length: number): string =>
  new TextDecoder().decode(bytes.slice(offset, offset + length));

const isPng = (bytes: Uint8Array): boolean =>
  bytes.length >= 8 && bytes.slice(0, 8).every((value, index) => value === [137, 80, 78, 71, 13, 10, 26, 10][index]);

const isJpeg = (bytes: Uint8Array): boolean => bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;

const isWebp = (bytes: Uint8Array): boolean =>
  bytes.length >= 12 && textAt(bytes, 0, 4) === 'RIFF' && textAt(bytes, 8, 4) === 'WEBP';

const detectContentType = async (
  bytes: Uint8Array,
  declaredContentType: string,
): Promise<WorkChatAttachmentContentType> => {
  let detectedContentType: WorkChatAttachmentContentType | undefined;
  if (isJpeg(bytes) || isPng(bytes) || isWebp(bytes)) {
    try {
      const decoded = sharp(bytes, { failOn: 'warning', limitInputPixels: 25_000_000 });
      const metadata = await decoded.metadata();
      const format = metadata.format;
      detectedContentType = format === 'jpeg'
        ? 'image/jpeg'
        : format === 'png'
          ? 'image/png'
          : format === 'webp'
            ? 'image/webp'
            : undefined;
      if (detectedContentType) await decoded.clone().raw().toBuffer();
    } catch {
      detectedContentType = undefined;
    }
  } else if (textAt(bytes, 0, 5) === '%PDF-') {
    detectedContentType = 'application/pdf';
  } else if (bytes.length >= 12 && textAt(bytes, 4, 4) === 'ftyp') {
    detectedContentType = textAt(bytes, 8, 4) === 'qt  ' ? 'video/quicktime' : 'video/mp4';
  } else if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    detectedContentType = 'video/webm';
  }

  if (!detectedContentType || declaredContentType !== detectedContentType) {
    throw new UnsupportedWorkChatAttachmentError('Attachment must be a valid image, PDF, or video file');
  }
  return detectedContentType;
};

const safeFilename = (name: string): string => {
  const trimmed = name.trim().replaceAll('\\', '/').split('/').pop()?.trim() ?? '';
  return (trimmed || 'attachment').slice(0, 255);
};

export const createWorkChatStorage = ({
  keyPrefix,
  bucket: configuredBucket,
  client,
  maxSizeBytes = MAX_ATTACHMENT_SIZE_BYTES,
  urlLifetimeSeconds = LINK_LIFETIME_SECONDS,
}: WorkChatStorageConfig) => {
  const storageBucket = configuredBucket ?? env.s3Bucket;
  const s3 = client ?? new Bun.S3Client({
    accessKeyId: env.s3AccessKeyId,
    secretAccessKey: env.s3SecretAccessKey,
    bucket: storageBucket,
    endpoint: env.s3Endpoint,
    region: env.s3Region,
  });

  const upload = async (memberId: string, file: File): Promise<StoredWorkChatAttachment & { fileName: string }> => {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.length === 0) throw new UnsupportedWorkChatAttachmentError('Attachment file is empty');
    if (bytes.length > maxSizeBytes) {
      throw new WorkChatAttachmentTooLargeError('Attachment must be 10 MB or smaller');
    }
    const contentType = await detectContentType(bytes, file.type);
    if (!storageBucket) throw new WorkChatAttachmentUploadError('Object storage is not configured');

    const objectKey = `${keyPrefix}/${memberId}/${crypto.randomUUID()}.${extensionByContentType[contentType]}`;
    try {
      const writtenBytes = await s3.write(objectKey, new Blob([bytes], { type: contentType }), { type: contentType });
      if (writtenBytes !== bytes.length) throw new Error(`Expected ${bytes.length} bytes but wrote ${writtenBytes}`);
    } catch (error) {
      try {
        await s3.delete(objectKey, { bucket: storageBucket });
      } catch (cleanupError) {
        console.error('[work-chat-attachment-upload] Compensating object deletion failed', {
          bucket: storageBucket,
          cleanupError,
          objectKey,
        });
      }
      throw new WorkChatAttachmentUploadError('Attachment upload failed', { cause: error });
    }

    return {
      bucket: storageBucket,
      objectKey,
      contentType,
      sizeBytes: bytes.length,
      fileName: safeFilename(file.name),
    };
  };

  const remove = async (stored: Pick<StoredWorkChatAttachment, 'bucket' | 'objectKey'>): Promise<void> => {
    await s3.delete(stored.objectKey, { bucket: stored.bucket });
  };

  const linkFor = ({ bucket, objectKey }: Pick<StoredWorkChatAttachment, 'bucket' | 'objectKey'>): WorkChatAttachmentLink => {
    if (!env.s3AccessKeyId || !env.s3SecretAccessKey || !env.s3Endpoint || !env.s3Region) {
      throw new WorkChatAttachmentLinkUnavailableError('Object storage is not configured');
    }
    return {
      url: s3.presign(objectKey, { bucket, expiresIn: urlLifetimeSeconds }),
      expiresAt: new Date(Date.now() + urlLifetimeSeconds * 1000),
    };
  };

  return { linkFor, remove, upload };
};

export const workChatStorage = createWorkChatStorage({
  keyPrefix: 'work-chat',
});
