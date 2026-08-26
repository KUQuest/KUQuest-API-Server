import * as questService from '@/modules/quest/quest.service';
import {
  addQuestImagesController,
  deleteQuestImageController,
  getQuestDetailController,
} from '@/modules/quest/quest.controller';
import { questStorage } from '@/modules/quest/quest.storage';
import {
  ImageTooLargeError,
  ImageUploadError,
  UnsupportedImageTypeError,
} from '@/shared/image-storage';

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';

const hirerId = 'hirer-1';
const questId = '018f47a7-1c7d-7c98-9a11-690d7e83430c';
const imageId = '018f47a7-1c7d-7c98-9a11-690d7e834301';

const session = { user: { id: hirerId } };
const image = new File(['image-content'], 'quest.png', { type: 'image/png' });
const secondImage = new File(['image-content'], 'second.png', { type: 'image/png' });
const storedImage = {
  fileId: imageId,
  position: 0,
  bucket: 'kuquest',
  objectKey: 'quests/hirer-1/quest.png',
};
const uploadedImage = {
  bucket: storedImage.bucket,
  objectKey: storedImage.objectKey,
  contentType: 'image/png' as const,
  sizeBytes: image.size,
};

afterEach(() => mock.restore());

describe('addQuestImagesController', () => {
  let uploadCheckOutcome: Awaited<ReturnType<typeof questService.checkQuestImageUpload>>;

  beforeEach(() => {
    uploadCheckOutcome = undefined;
    spyOn(questService, 'checkQuestImageUpload').mockImplementation(
      async () => uploadCheckOutcome,
    );
  });

  it('returns the complete ordered image list with expiring links', async () => {
    spyOn(questService, 'addQuestImages').mockResolvedValue({ images: [storedImage] });
    spyOn(questStorage, 'upload').mockResolvedValue({
      bucket: storedImage.bucket,
      objectKey: storedImage.objectKey,
      contentType: 'image/png',
      sizeBytes: image.size,
    });
    spyOn(questStorage, 'linkFor').mockReturnValue('https://storage.test/signed-link');

    const result = await addQuestImagesController({
      body: { images: [image] },
      params: { questId },
      session: session as never,
      set: {} as never,
    });

    expect(result).toEqual({
      success: true,
      data: {
        images: [
          {
            fileId: imageId,
            position: 0,
            url: 'https://storage.test/signed-link',
          },
        ],
      },
    });
    expect(questService.addQuestImages).toHaveBeenCalledWith(hirerId, questId, [
      expect.objectContaining({
        bucket: storedImage.bucket,
        objectKey: storedImage.objectKey,
      }),
    ]);
  });

  it('rejects a non-Draft Quest before uploading files', async () => {
    uploadCheckOutcome = { outcome: 'not-editable' };
    const upload = spyOn(questStorage, 'upload');
    const set: { status?: number } = {};

    const result = await addQuestImagesController({
      body: { images: [image] },
      params: { questId },
      session: session as never,
      set: set as never,
    });

    expect(result).toEqual({
      success: false,
      error: { code: 'QUEST_NOT_EDITABLE', message: 'Only Draft Quests can be edited' },
    });
    expect(set.status).toBe(409);
    expect(upload).not.toHaveBeenCalled();
  });

  it('rejects an unowned Quest before uploading files', async () => {
    uploadCheckOutcome = { outcome: 'not-found' };
    const upload = spyOn(questStorage, 'upload');
    const set: { status?: number } = {};

    const result = await addQuestImagesController({
      body: { images: [image] },
      params: { questId },
      session: session as never,
      set: set as never,
    });

    expect(result).toEqual({
      success: false,
      error: { code: 'QUEST_NOT_FOUND', message: 'Quest not found' },
    });
    expect(set.status).toBe(404);
    expect(upload).not.toHaveBeenCalled();
  });

  it('deletes earlier objects when a later image upload fails', async () => {
    spyOn(questStorage, 'upload')
      .mockResolvedValueOnce(uploadedImage)
      .mockRejectedValueOnce(new UnsupportedImageTypeError('unsupported image'));
    const deleteObject = spyOn(questStorage, 'delete').mockResolvedValue();
    const set: { status?: number } = {};

    const result = await addQuestImagesController({
      body: { images: [image, secondImage] },
      params: { questId },
      session: session as never,
      set: set as never,
    });

    expect(result).toEqual({
      success: false,
      error: { code: 'UNSUPPORTED_IMAGE_TYPE', message: 'unsupported image' },
    });
    expect(set.status).toBe(415);
    expect(deleteObject).toHaveBeenCalledWith(uploadedImage.bucket, uploadedImage.objectKey);
  });

  it('cleans uploaded objects when database persistence fails', async () => {
    spyOn(questStorage, 'upload').mockResolvedValue(uploadedImage);
    const deleteObject = spyOn(questStorage, 'delete').mockResolvedValue();
    spyOn(questService, 'addQuestImages').mockRejectedValue(new Error('database unavailable'));

    const result = addQuestImagesController({
      body: { images: [image] },
      params: { questId },
      session: session as never,
      set: {} as never,
    });

    await expect(result).rejects.toThrow('database unavailable');
    expect(deleteObject).toHaveBeenCalledWith(uploadedImage.bucket, uploadedImage.objectKey);
  });

  it('maps a Quest image storage failure without exposing its detail', async () => {
    spyOn(questStorage, 'upload').mockRejectedValue(new ImageUploadError('secret detail'));
    const set: { status?: number } = {};

    const result = await addQuestImagesController({
      body: { images: [image] },
      params: { questId },
      session: session as never,
      set: set as never,
    });

    expect(result).toEqual({
      success: false,
      error: { code: 'IMAGE_UPLOAD_FAILED', message: 'Image upload failed' },
    });
    expect(set.status).toBe(502);
    expect(JSON.stringify(result)).not.toContain('secret detail');
  });

  it('maps an oversized Quest image to the shared image error', async () => {
    spyOn(questStorage, 'upload').mockRejectedValue(new ImageTooLargeError('too large'));
    const set: { status?: number } = {};

    const result = await addQuestImagesController({
      body: { images: [image] },
      params: { questId },
      session: session as never,
      set: set as never,
    });

    expect(result).toEqual({
      success: false,
      error: { code: 'IMAGE_TOO_LARGE', message: 'too large' },
    });
    expect(set.status).toBe(413);
  });

  it('maps a Quest image limit result and compensates uploaded objects', async () => {
    spyOn(questStorage, 'upload').mockResolvedValue(uploadedImage);
    const deleteObject = spyOn(questStorage, 'delete').mockResolvedValue();
    spyOn(questService, 'addQuestImages').mockResolvedValue({ outcome: 'limit-reached' });
    const set: { status?: number } = {};

    const result = await addQuestImagesController({
      body: { images: [image] },
      params: { questId },
      session: session as never,
      set: set as never,
    });

    expect(result).toEqual({
      success: false,
      error: {
        code: 'QUEST_IMAGE_LIMIT_REACHED',
        message: 'A Quest can have at most 3 images',
      },
    });
    expect(set.status).toBe(409);
    expect(deleteObject).toHaveBeenCalledWith(uploadedImage.bucket, uploadedImage.objectKey);
  });
});

describe('deleteQuestImageController', () => {
  it('deletes the stored object after the service commits the database change', async () => {
    spyOn(questService, 'deleteQuestImage').mockResolvedValue({
      outcome: 'deleted',
      bucket: storedImage.bucket,
      objectKey: storedImage.objectKey,
    });
    const deleteObject = spyOn(questStorage, 'delete').mockResolvedValue();

    const result = await deleteQuestImageController({
      params: { questId, imageId },
      session: session as never,
      set: {} as never,
    });

    expect(result).toEqual({ success: true });
    expect(deleteObject).toHaveBeenCalledWith(storedImage.bucket, storedImage.objectKey);
  });

  it('returns success when object cleanup fails after the database change', async () => {
    spyOn(questService, 'deleteQuestImage').mockResolvedValue({
      outcome: 'deleted',
      bucket: storedImage.bucket,
      objectKey: storedImage.objectKey,
    });
    spyOn(questStorage, 'delete').mockRejectedValue(new Error('storage unavailable'));

    const result = await deleteQuestImageController({
      params: { questId, imageId },
      session: session as never,
      set: {} as never,
    });

    expect(result).toEqual({ success: true });
  });

  it('maps a missing Quest Image to QUEST_NOT_FOUND', async () => {
    spyOn(questService, 'deleteQuestImage').mockResolvedValue({ outcome: 'not-found' });
    const set: { status?: number } = {};

    const result = await deleteQuestImageController({
      params: { questId, imageId },
      session: session as never,
      set: set as never,
    });

    expect(result).toEqual({
      success: false,
      error: { code: 'QUEST_NOT_FOUND', message: 'Quest not found' },
    });
    expect(set.status).toBe(404);
  });

  it('maps a non-Draft Quest to QUEST_NOT_EDITABLE', async () => {
    spyOn(questService, 'deleteQuestImage').mockResolvedValue({ outcome: 'not-editable' });
    const set: { status?: number } = {};

    const result = await deleteQuestImageController({
      params: { questId, imageId },
      session: session as never,
      set: set as never,
    });

    expect(result).toEqual({
      success: false,
      error: { code: 'QUEST_NOT_EDITABLE', message: 'Only Draft Quests can be edited' },
    });
    expect(set.status).toBe(409);
  });
});

describe('getQuestDetailController', () => {
  it('serializes Quest Image references with expiring links', async () => {
    spyOn(questService, 'getQuestDetail').mockResolvedValue({
      id: questId,
      title: 'Quest title',
      description: null,
      condition: 'Complete the work',
      reward: 500,
      tag: null,
      mode: 'FIRST_COME_FIRST_SERVED',
      participation: 'SINGLE',
      questStatus: 'DRAFT',
      headcount: 1,
      startTime: '2030-08-27T10:00:00.000Z',
      dueAt: '2030-08-27T12:00:00.000Z',
      estimatedDurationMinutes: 120,
      proofRequired: true,
      hirerName: 'Image Hirer',
      locations: [],
      images: [storedImage],
    } as never);
    spyOn(questStorage, 'linkFor').mockReturnValue('https://storage.test/signed-link');

    const result = await getQuestDetailController({
      params: { questId },
      session: session as never,
      set: {} as never,
    });

    expect(result).toMatchObject({
      success: true,
      data: {
        images: [{ fileId: imageId, position: 0, url: 'https://storage.test/signed-link' }],
      },
    });
  });

  it('omits only the Quest Image whose link cannot be built', async () => {
    const secondStoredImage = {
      ...storedImage,
      fileId: '018f47a7-1c7d-7c98-9a11-690d7e834302',
      position: 1,
      objectKey: 'quests/hirer-1/second.png',
    };
    spyOn(questService, 'getQuestDetail').mockResolvedValue({
      id: questId,
      title: 'Quest title',
      description: null,
      condition: 'Complete the work',
      reward: 500,
      tag: null,
      mode: 'FIRST_COME_FIRST_SERVED',
      participation: 'SINGLE',
      questStatus: 'DRAFT',
      headcount: 1,
      startTime: '2030-08-27T10:00:00.000Z',
      dueAt: '2030-08-27T12:00:00.000Z',
      estimatedDurationMinutes: 120,
      proofRequired: true,
      hirerName: 'Image Hirer',
      locations: [],
      images: [storedImage, secondStoredImage],
    } as never);
    spyOn(questStorage, 'linkFor').mockImplementation((questImage) => {
      if (questImage.objectKey === storedImage.objectKey) throw new Error('storage unavailable');

      return 'https://storage.test/second-signed-link';
    });

    const result = await getQuestDetailController({
      params: { questId },
      session: session as never,
      set: {} as never,
    });

    expect(result).toMatchObject({
      success: true,
      data: {
        images: [
          {
            fileId: secondStoredImage.fileId,
            position: secondStoredImage.position,
            url: 'https://storage.test/second-signed-link',
          },
        ],
      },
    });
  });
});
