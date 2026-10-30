import {
  createObjectStorage,
  type StoredFile,
  type AttachmentContentType,
} from '@/shared/object-storage';

export type StoredQuestV2ProofFile = StoredFile<AttachmentContentType> & {
  fileName: string;
};

export const questV2ProofStorage = createObjectStorage({
  keyPrefix: 'proof-submissions',
  policy: 'image-pdf-video',
  emptyFileMessage: 'Attachment file is empty',
  tooLargeMessage: 'Attachment must be 10 MB or smaller',
  unsupportedTypeMessage: 'Attachment must be a valid image, PDF, or video file',
});
