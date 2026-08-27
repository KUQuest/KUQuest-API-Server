import * as proofService from '@/modules/quest/quest-proof.service';
import { reviewProofController, submitProofController } from '@/modules/quest/quest-proof.controller';
import { proofStorage } from '@/modules/quest/quest-proof.storage';

import { afterEach, describe, expect, mock, spyOn, it } from 'bun:test';

const session = { user: { id: 'worker-1' } };
const questId = '018f47a7-1c7d-7c98-9a11-690d7e83430c';
const fileId = '018f47a7-1c7d-7c98-9a11-690d7e834301';
const uploaded = { bucket: 'kuquest', objectKey: 'proofs/worker-1/a.png', contentType: 'image/png' as const, sizeBytes: 1 };
const set = {} as { status?: number };

afterEach(() => mock.restore());

describe('reviewProofController', () => {
  it('maps a Quest outside the review lifecycle to a conflict', async () => {
    spyOn(proofService, 'reviewProof').mockResolvedValue({ outcome: 'invalid-review-state' });
    const result = await reviewProofController({
      session: session as never,
      set,
      params: { questId, proofId: fileId },
      body: { status: 'PROOF_APPROVED' },
    } as never);
    expect(set.status).toBe(409);
    expect(result).toEqual({ success: false, error: { code: 'QUEST_NOT_IN_REVIEW', message: 'The Quest is not in the proof review lifecycle' } });
  });
});

describe('submitProofController', () => {
  it('rejects multipart images combined with existing file IDs', async () => {
    spyOn(proofStorage, 'upload').mockResolvedValue(uploaded);
    const deleteImage = spyOn(proofStorage, 'delete').mockResolvedValue(undefined);
    const submit = spyOn(proofService, 'submitProof');

    const result = await submitProofController({
      session: session as never,
      set,
      params: { questId },
      body: {
        content: 'done',
        fileIds: [fileId],
        images: [new File(['x'], 'proof.png', { type: 'image/png' })],
      },
    } as never);

    expect(set.status).toBe(400);
    expect(result).toEqual({ success: false, error: { code: 'PROOF_FILES_CONFLICT', message: 'Use multipart images or existing file IDs, not both' } });
    expect(submit).not.toHaveBeenCalled();
    expect(deleteImage).toHaveBeenCalledTimes(1);
  });
});
