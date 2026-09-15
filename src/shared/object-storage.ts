import { env } from '@/config/env';

import sharp from 'sharp';

export const imageContentTypeByExtension = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
} as const;

export const attachmentContentTypeByExtension = {
  ...imageContentTypeByExtension,
  'application/pdf': 'pdf',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
} as const;

export type ImageContentType = keyof typeof imageContentTypeByExtension;
export type AttachmentContentType = keyof typeof attachmentContentTypeByExtension;
export type StorageContentType = AttachmentContentType;

export type StoredFile<TContentType extends string = StorageContentType> = {
  bucket: string;
  objectKey: string;
  contentType: TContentType;
  sizeBytes: number;
};

// Aliases for clean migration — zero difference
export type StoredImage = StoredFile<ImageContentType>;
export type FileUploadPlan = Pick<StoredFile, 'bucket' | 'objectKey'>;

export type FileLink = {
  url: string;
  expiresAt: Date;
};

// Canonical errors — four, shared across every storage bucket
export class FileTooLargeError extends Error {}
export class UnsupportedFileTypeError extends Error {}
export class FileUploadError<TContentType extends string = StorageContentType> extends Error {
  constructor(
    message: string,
    options?: ErrorOptions,
    readonly cleanupObject?: StoredFile<TContentType>
  ) {
    super(message, options);
  }
}
export class FileLinkUnavailableError extends Error {}

// Backwards-compatible aliases while consumers migrate
export const ImageTooLargeError = FileTooLargeError;
export type ImageTooLargeError = FileTooLargeError;
export const UnsupportedImageTypeError = UnsupportedFileTypeError;
export type UnsupportedImageTypeError = UnsupportedFileTypeError;
export const ImageUploadError = FileUploadError;
export type ImageUploadError = FileUploadError;
export const ImageLinkUnavailableError = FileLinkUnavailableError;
export type ImageLinkUnavailableError = FileLinkUnavailableError;

export const createDebugLogger =
  (label: string) =>
  (message: string, details?: unknown): void => {
    if (env.nodeEnv !== 'test') {
      console.info(`[${label}] ${message}`, details ?? '');
    }
  };

export type StorageContentPolicy = 'image-only' | 'image-pdf-video';

export type ObjectStorageConfig = {
  keyPrefix: string;
  bucket?: string;
  logLabel?: string;
  policy?: StorageContentPolicy;
  client?: Pick<Bun.S3Client, 'write' | 'delete' | 'presign'>;
  maxSizeBytes?: number;
  urlLifetimeSeconds?: number;
  emptyFileMessage?: string;
  tooLargeMessage?: string;
  unsupportedTypeMessage?: string;
};

const maxImagePixels = 25_000_000;
const defaultMaxSizeBytesByPolicy = {
  'image-only': 5 * 1024 * 1024,
  'image-pdf-video': 10 * 1024 * 1024,
} as const;
const defaultUrlLifetimeSeconds = 15 * 60;

const contentTypeByFormat = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
} as const;

const textAt = (bytes: Uint8Array, offset: number, length: number): string =>
  new TextDecoder().decode(bytes.slice(offset, offset + length));

const isPng = (bytes: Uint8Array): boolean =>
  bytes.length >= 8 &&
  bytes.slice(0, 8).every((value, index) => value === [137, 80, 78, 71, 13, 10, 26, 10][index]);

const isJpeg = (bytes: Uint8Array): boolean =>
  bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;

const isWebp = (bytes: Uint8Array): boolean =>
  bytes.length >= 12 && textAt(bytes, 0, 4) === 'RIFF' && textAt(bytes, 8, 4) === 'WEBP';

const decodeImageContentType = async (bytes: Uint8Array): Promise<ImageContentType | undefined> => {
  try {
    const decoded = sharp(bytes, { failOn: 'warning', limitInputPixels: maxImagePixels });
    const metadata = await decoded.metadata();
    const contentType = metadata.format
      ? contentTypeByFormat[metadata.format as keyof typeof contentTypeByFormat]
      : undefined;
    if (contentType) await decoded.clone().raw().toBuffer();
    return contentType;
  } catch {
    return undefined;
  }
};

const detectContentType = async (
  bytes: Uint8Array,
  declaredContentType: string,
  policy: StorageContentPolicy,
  unsupportedTypeMessage: string
): Promise<AttachmentContentType> => {
  let detectedContentType: AttachmentContentType | undefined;

  if (policy === 'image-only') {
    detectedContentType = await decodeImageContentType(bytes);
  } else if (isJpeg(bytes) || isPng(bytes) || isWebp(bytes)) {
    detectedContentType = await decodeImageContentType(bytes);
  } else if (textAt(bytes, 0, 5) === '%PDF-') {
    detectedContentType = 'application/pdf';
  } else if (bytes.length >= 12 && textAt(bytes, 4, 4) === 'ftyp') {
    detectedContentType = textAt(bytes, 8, 4) === 'qt  ' ? 'video/quicktime' : 'video/mp4';
  } else if (
    bytes.length >= 4 &&
    bytes[0] === 0x1a &&
    bytes[1] === 0x45 &&
    bytes[2] === 0xdf &&
    bytes[3] === 0xa3
  ) {
    detectedContentType = 'video/webm';
  }

  if (!detectedContentType || declaredContentType !== detectedContentType) {
    throw new UnsupportedFileTypeError(unsupportedTypeMessage);
  }
  return detectedContentType;
};

const safeFilename = (name: string): string => {
  const trimmed = name.trim().replaceAll('\\', '/').split('/').pop()?.trim() ?? '';
  return (trimmed || 'attachment').slice(0, 255);
};

type CreatedObjectStorage<TContentType extends string> = {
  delete: (bucket: string, objectKey: string) => Promise<void>;
  linkFor: (target: Pick<StoredFile<TContentType>, 'bucket' | 'objectKey'>) => string;
  linkForWithExpiry: (target: Pick<StoredFile<TContentType>, 'bucket' | 'objectKey'>) => FileLink;
  prepareUpload: (targetId: string) => FileUploadPlan;
  upload: (
    targetId: string,
    file: File,
    plan?: FileUploadPlan
  ) => Promise<StoredFile<TContentType> & { fileName: string }>;
};

export function createObjectStorage(
  config: ObjectStorageConfig & { policy?: 'image-only' }
): CreatedObjectStorage<ImageContentType>;
export function createObjectStorage(
  config: ObjectStorageConfig & { policy: 'image-pdf-video' }
): CreatedObjectStorage<AttachmentContentType>;
export function createObjectStorage({
  keyPrefix,
  bucket: configuredBucket,
  logLabel = `${keyPrefix}-upload`,
  policy = 'image-only',
  client,
  maxSizeBytes = defaultMaxSizeBytesByPolicy[policy],
  urlLifetimeSeconds = defaultUrlLifetimeSeconds,
  emptyFileMessage = 'Image file is empty',
  tooLargeMessage = `Image must be ${Math.floor(maxSizeBytes / (1024 * 1024))} MB or smaller`,
  unsupportedTypeMessage = 'Image must be a valid JPEG, PNG, or WebP file',
}: ObjectStorageConfig) {
  const log = createDebugLogger(logLabel);
  const storageBucket = configuredBucket ?? env.s3Bucket;

  const s3 =
    client ??
    new Bun.S3Client({
      accessKeyId: env.s3AccessKeyId,
      secretAccessKey: env.s3SecretAccessKey,
      bucket: storageBucket,
      endpoint: env.s3Endpoint,
      region: env.s3Region,
    });

  const prepareUpload = (targetId: string): FileUploadPlan => {
    if (!storageBucket) {
      throw new FileUploadError('Object storage is not configured');
    }

    return {
      bucket: storageBucket,
      objectKey: `${keyPrefix}/${targetId}/${crypto.randomUUID()}`,
    };
  };

  const upload = async (
    targetId: string,
    file: File,
    plan?: FileUploadPlan
  ): Promise<StoredFile & { fileName: string }> => {
    log('Validating file', {
      declaredContentType: file.type,
      sizeBytes: file.size,
      targetId,
    });

    if (file.size === 0) {
      throw new UnsupportedFileTypeError(emptyFileMessage);
    }
    if (file.size > maxSizeBytes) {
      throw new FileTooLargeError(tooLargeMessage);
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.length === 0) {
      throw new UnsupportedFileTypeError(emptyFileMessage);
    }
    if (bytes.length > maxSizeBytes) {
      throw new FileTooLargeError(tooLargeMessage);
    }

    const contentType = await detectContentType(bytes, file.type, policy, unsupportedTypeMessage);

    if (!storageBucket) {
      throw new FileUploadError('Object storage is not configured');
    }

    if (plan && plan.bucket !== storageBucket) {
      throw new FileUploadError('Upload plan does not belong to this storage');
    }

    const objectKey =
      plan?.objectKey ??
      `${keyPrefix}/${targetId}/${crypto.randomUUID()}.${attachmentContentTypeByExtension[contentType]}`;

    try {
      const writtenBytes = await s3.write(objectKey, new Blob([bytes], { type: contentType }), {
        type: contentType,
      });
      if (writtenBytes !== bytes.length) {
        throw new Error(`Expected ${bytes.length} bytes but wrote ${writtenBytes}`);
      }
    } catch (error) {
      console.error(`[${logLabel}] Upload failed`, { bucket: storageBucket, error, objectKey });
      let cleanupObject: StoredFile | undefined;
      try {
        await s3.delete(objectKey, { bucket: storageBucket });
      } catch (cleanupError) {
        cleanupObject = { bucket: storageBucket, objectKey, contentType, sizeBytes: bytes.length };
        console.error(`[${logLabel}] Compensating object deletion failed`, {
          bucket: storageBucket,
          cleanupError,
          objectKey,
        });
      }
      throw new FileUploadError('File upload failed', { cause: error }, cleanupObject);
    }

    log('Upload succeeded', { bucket: storageBucket, objectKey, targetId });

    return {
      bucket: storageBucket,
      objectKey,
      contentType,
      sizeBytes: bytes.length,
      fileName: safeFilename(file.name),
    };
  };

  const deleteFile = async (bucket: string, objectKey: string): Promise<void> => {
    log('Deleting object', { bucket, objectKey });
    await s3.delete(objectKey, { bucket });
  };

  const temporaryLinkFor = ({
    bucket,
    objectKey,
  }: Pick<StoredFile, 'bucket' | 'objectKey'>): FileLink => {
    if (
      !client &&
      (!env.s3AccessKeyId || !env.s3SecretAccessKey || !env.s3Endpoint || !env.s3Region)
    ) {
      throw new FileLinkUnavailableError('Object storage is not configured');
    }

    try {
      return {
        url: s3.presign(objectKey, { bucket, expiresIn: urlLifetimeSeconds }),
        expiresAt: new Date(Date.now() + urlLifetimeSeconds * 1000),
      };
    } catch (error) {
      throw new FileLinkUnavailableError('File link could not be created', { cause: error });
    }
  };

  const linkFor = (target: Pick<StoredFile, 'bucket' | 'objectKey'>): string =>
    temporaryLinkFor(target).url;

  const linkForWithExpiry = (target: Pick<StoredFile, 'bucket' | 'objectKey'>): FileLink =>
    temporaryLinkFor(target);

  return {
    delete: deleteFile,
    linkFor,
    linkForWithExpiry,
    prepareUpload,
    upload,
  };
}
