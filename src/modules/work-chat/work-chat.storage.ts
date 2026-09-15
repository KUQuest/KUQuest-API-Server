import {
  createObjectStorage,
  type AttachmentContentType,
  type StoredFile,
  type FileLink,
  FileTooLargeError,
  UnsupportedFileTypeError,
  FileUploadError,
  FileLinkUnavailableError,
} from '@/shared/object-storage';

export type WorkChatAttachmentContentType = AttachmentContentType;
export type StoredWorkChatAttachment = StoredFile<WorkChatAttachmentContentType>;
export type WorkChatAttachmentLink = FileLink;

export const WorkChatAttachmentTooLargeError = FileTooLargeError;
export type WorkChatAttachmentTooLargeError = FileTooLargeError;
export const UnsupportedWorkChatAttachmentError = UnsupportedFileTypeError;
export type UnsupportedWorkChatAttachmentError = UnsupportedFileTypeError;
export const WorkChatAttachmentUploadError = FileUploadError;
export type WorkChatAttachmentUploadError = FileUploadError;
export const WorkChatAttachmentLinkUnavailableError = FileLinkUnavailableError;
export type WorkChatAttachmentLinkUnavailableError = FileLinkUnavailableError;

export const createWorkChatStorage = (config?: {
  keyPrefix?: string;
  bucket?: string;
  client?: Parameters<typeof createObjectStorage>[0]['client'];
  maxSizeBytes?: number;
  urlLifetimeSeconds?: number;
}) => {
  const storage = createObjectStorage({
    keyPrefix: config?.keyPrefix ?? 'work-chat',
    bucket: config?.bucket,
    client: config?.client,
    policy: 'image-pdf-video',
    maxSizeBytes: config?.maxSizeBytes,
    urlLifetimeSeconds: config?.urlLifetimeSeconds,
    emptyFileMessage: 'Attachment file is empty',
    tooLargeMessage: 'Attachment must be 10 MB or smaller',
    unsupportedTypeMessage: 'Attachment must be a valid image, PDF, or video file',
  });

  return {
    upload: storage.upload,
    remove: (stored: Pick<StoredWorkChatAttachment, 'bucket' | 'objectKey'>) =>
      storage.delete(stored.bucket, stored.objectKey),
    linkFor: (target: Pick<StoredWorkChatAttachment, 'bucket' | 'objectKey'>) =>
      storage.linkForWithExpiry(target),
  };
};

export const workChatStorage = createWorkChatStorage();
