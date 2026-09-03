import {
  createWorkChatStorage,
  type StoredWorkChatAttachment,
} from '@/modules/work-chat/work-chat.storage';

export type StoredQuestV2ProofFile = StoredWorkChatAttachment & {
  fileName: string;
};

/** Proof files use the same validation and object-storage boundary as Work Chat attachments. */
export const questV2ProofStorage = createWorkChatStorage({
  keyPrefix: 'proof-submissions',
});
