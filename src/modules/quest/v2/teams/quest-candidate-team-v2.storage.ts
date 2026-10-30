import {
  createObjectStorage,
  type AttachmentContentType,
  type StoredFile,
} from '@/shared/object-storage';

export type StoredQuestV2CandidateTeamFile = StoredFile<AttachmentContentType> & {
  fileName: string;
};

const storage = createObjectStorage({
  keyPrefix: 'candidate-team-submissions',
  policy: 'image-pdf-video',
  emptyFileMessage: 'Attachment file is empty',
  tooLargeMessage: 'Attachment must be 10 MB or smaller',
  unsupportedTypeMessage: 'Attachment must be a valid image, PDF, or video file',
});

export const questV2CandidateTeamStorage = {
  ...storage,
  remove: (stored: Pick<StoredQuestV2CandidateTeamFile, 'bucket' | 'objectKey'>) =>
    storage.delete(stored.bucket, stored.objectKey),
};
