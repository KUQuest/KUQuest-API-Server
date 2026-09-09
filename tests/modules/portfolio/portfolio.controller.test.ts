import {
  createOwnPortfolio,
  deleteOwnPortfolio,
  deleteOwnPortfolioImage,
  listOwnPortfolio,
  replaceOwnPortfolioImage,
  updateOwnPortfolio,
} from '@/modules/portfolio/portfolio.controller';
import * as portfolioService from '@/modules/portfolio/portfolio.service';
import { portfolioStorage } from '@/modules/portfolio/portfolio.storage';
import { ImageTooLargeError, ImageUploadError, UnsupportedImageTypeError } from '@/shared/image-storage';

import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';

const studentAuthId = 'student-1';
const portfolioId = '018f47a7-1c7d-7c98-9a11-690d7e83430c';
const fileIdOne = '018f47a7-1c7d-7c98-9a11-690d7e834301';
const fileIdTwo = '018f47a7-1c7d-7c98-9a11-690d7e834302';

const session = { user: { id: studentAuthId } };

afterEach(() => {
  mock.restore();
});

describe('listOwnPortfolio', () => {
  const invoke = () => listOwnPortfolio({ session: session as never, set: {} as never });

  it('turns stored image references into links that expire', async () => {
    spyOn(portfolioService, 'listPortfolio').mockResolvedValue([
      {
        id: portfolioId,
        version: 1,
        title: 'Capstone',
        description: 'A short description',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        images: [
          { fileId: fileIdOne, position: 0, bucket: 'kuquest', objectKey: 'portfolio/a.png' },
        ],
      },
    ]);
    spyOn(portfolioStorage, 'linkFor').mockReturnValue('https://storage.test/signed-link');

    expect(await invoke()).toEqual({
      success: true,
      data: [
        {
          id: portfolioId,
          version: 1,
          title: 'Capstone',
          description: 'A short description',
          createdAt: '2026-01-01T00:00:00.000Z',
          images: [{ fileId: fileIdOne, position: 0, url: 'https://storage.test/signed-link' }],
        },
      ],
    });
  });

  it('drops only the image whose link cannot be built', async () => {
    spyOn(portfolioService, 'listPortfolio').mockResolvedValue([
      {
        id: portfolioId,
        version: 1,
        title: 'Capstone',
        description: null,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        images: [
          { fileId: fileIdOne, position: 0, bucket: 'kuquest', objectKey: 'portfolio/a.png' },
          { fileId: fileIdTwo, position: 1, bucket: 'kuquest', objectKey: 'portfolio/b.png' },
        ],
      },
    ]);
    spyOn(portfolioStorage, 'linkFor').mockImplementation((image) => {
      if (image.objectKey === 'portfolio/a.png') throw new Error('storage unavailable');
      return 'https://storage.test/signed-link';
    });

    const result = (await invoke()) as { data: Array<{ images: unknown[] }> };

    expect(result.data[0]?.images).toEqual([
      { fileId: fileIdTwo, position: 1, url: 'https://storage.test/signed-link' },
    ]);
  });
});

const invokeCreate = (images: File[], overrides: { title?: string; description?: string } = {}) => {
  const set: { status?: number | string } = {};

  return {
    result: createOwnPortfolio({
      body: { title: overrides.title ?? 'Capstone', description: overrides.description, images },
      session: session as never,
      set: set as never,
    }),
    set,
  };
};

const png = (name: string) => new File(['image-content'], name, { type: 'image/png' });

describe('createOwnPortfolio', () => {
  it('uploads every image before creating the entry', async () => {
    const uploadedA = {
      bucket: 'kuquest',
      objectKey: `portfolio/${studentAuthId}/a.png`,
      contentType: 'image/png' as const,
      sizeBytes: 12,
    };
    const uploadedB = {
      bucket: 'kuquest',
      objectKey: `portfolio/${studentAuthId}/b.png`,
      contentType: 'image/png' as const,
      sizeBytes: 12,
    };
    const upload = spyOn(portfolioStorage, 'upload')
      .mockResolvedValueOnce(uploadedA)
      .mockResolvedValueOnce(uploadedB);
    spyOn(portfolioService, 'createPortfolio').mockResolvedValue({ id: portfolioId });

    const { result, set } = invokeCreate([png('a.png'), png('b.png')]);

    expect(await result).toEqual({ success: true, data: { id: portfolioId } });
    expect(set.status).toBeUndefined();
    expect(upload).toHaveBeenCalledTimes(2);
    expect(portfolioService.createPortfolio).toHaveBeenCalledWith(studentAuthId, {
      title: 'Capstone',
      description: undefined,
      images: [uploadedA, uploadedB],
    });
  });

  it('discards every uploaded image when a later one fails validation', async () => {
    const uploadedA = {
      bucket: 'kuquest',
      objectKey: `portfolio/${studentAuthId}/a.png`,
      contentType: 'image/png' as const,
      sizeBytes: 12,
    };
    const upload = spyOn(portfolioStorage, 'upload')
      .mockResolvedValueOnce(uploadedA)
      .mockRejectedValueOnce(
        new UnsupportedImageTypeError('Image must be a valid JPEG, PNG, or WebP file'),
      );
    const deleteObject = spyOn(portfolioStorage, 'delete').mockResolvedValue();

    const { result, set } = invokeCreate([png('a.png'), png('bad.png')]);

    expect(await result).toEqual({
      success: false,
      error: {
        code: 'UNSUPPORTED_IMAGE_TYPE',
        message: 'Image must be a valid JPEG, PNG, or WebP file',
      },
    });
    expect(set.status).toBe(415);
    expect(upload).toHaveBeenCalledTimes(2);
    expect(deleteObject).toHaveBeenCalledWith(uploadedA.bucket, uploadedA.objectKey);
  });

  it('returns a safe error and discards uploads when persistence fails', async () => {
    const uploadedA = {
      bucket: 'kuquest',
      objectKey: `portfolio/${studentAuthId}/a.png`,
      contentType: 'image/png' as const,
      sizeBytes: 12,
    };
    spyOn(portfolioStorage, 'upload').mockResolvedValue(uploadedA);
    const deleteObject = spyOn(portfolioStorage, 'delete').mockResolvedValue();
    spyOn(portfolioService, 'createPortfolio').mockRejectedValue(new Error('db down'));

    const { result } = invokeCreate([png('a.png')]);

    await expect(result).rejects.toThrow('db down');
    expect(deleteObject).toHaveBeenCalledWith(uploadedA.bucket, uploadedA.objectKey);
  });

  it('returns a safe error when object storage rejects the upload', async () => {
    spyOn(portfolioStorage, 'upload').mockRejectedValue(
      new ImageUploadError('secret storage detail'),
    );

    const { result, set } = invokeCreate([png('a.png')]);
    const body = await result;

    expect(set.status).toBe(502);
    expect(body).toEqual({
      success: false,
      error: { code: 'IMAGE_UPLOAD_FAILED', message: 'Image upload failed' },
    });
    expect(JSON.stringify(body)).not.toContain('secret storage detail');
  });
});

const invokeUpdate = (body: Record<string, unknown> = { title: 'Updated' }) => {
  const set: { status?: number | string } = {};

  return {
    result: updateOwnPortfolio({
      params: { portfolioId },
      body: body as never,
      session: session as never,
      set: set as never,
    }),
    set,
  };
};

describe('updateOwnPortfolio', () => {
  it('answers a completed update without echoing the entry back', async () => {
    spyOn(portfolioService, 'updatePortfolio').mockResolvedValue('updated');

    const { result, set } = invokeUpdate();

    expect(await result).toEqual({ success: true });
    expect(set.status).toBeUndefined();
    expect(portfolioService.updatePortfolio).toHaveBeenCalledWith(studentAuthId, portfolioId, {
      title: 'Updated',
    }, undefined);
  });

  it('reports a missing or unowned entry as not found', async () => {
    spyOn(portfolioService, 'updatePortfolio').mockResolvedValue('not-found');

    const { result, set } = invokeUpdate();

    expect(await result).toEqual({
      success: false,
      error: { code: 'PORTFOLIO_NOT_FOUND', message: 'Portfolio item not found' },
    });
    expect(set.status).toBe(404);
  });
});

const invokeDelete = () => {
  const set: { status?: number | string } = {};

  return {
    result: deleteOwnPortfolio({
      params: { portfolioId },
      session: session as never,
      set: set as never,
    }),
    set,
  };
};

describe('deleteOwnPortfolio', () => {
  it('deletes every stored image after removing the entry', async () => {
    spyOn(portfolioService, 'deletePortfolio').mockResolvedValue({
      outcome: 'deleted',
      images: [{ fileId: fileIdOne, bucket: 'kuquest', objectKey: 'portfolio/a.png' }],
      version: 2,
    });
    const deleteObject = spyOn(portfolioStorage, 'delete').mockResolvedValue();
    const markDeleted = spyOn(portfolioService, 'markPortfolioImageDeleted').mockResolvedValue();

    const { result, set } = invokeDelete();

    expect(await result).toEqual({ success: true, data: { version: 2 } });
    expect(set.status).toBeUndefined();
    expect(deleteObject).toHaveBeenCalledWith('kuquest', 'portfolio/a.png');
    expect(markDeleted).toHaveBeenCalledWith(studentAuthId, fileIdOne);
  });

  it('still reports success when storage cleanup for an image fails', async () => {
    spyOn(portfolioService, 'deletePortfolio').mockResolvedValue({
      outcome: 'deleted',
      images: [{ fileId: fileIdOne, bucket: 'kuquest', objectKey: 'portfolio/a.png' }],
      version: 2,
    });
    spyOn(portfolioStorage, 'delete').mockRejectedValue(new Error('object storage down'));

    const { result, set } = invokeDelete();

    expect(await result).toEqual({ success: true, data: { version: 2 } });
    expect(set.status).toBeUndefined();
  });

  it('reports a missing or unowned entry as not found', async () => {
    spyOn(portfolioService, 'deletePortfolio').mockResolvedValue({ outcome: 'not-found' });

    const { result, set } = invokeDelete();

    expect(await result).toEqual({
      success: false,
      error: { code: 'PORTFOLIO_NOT_FOUND', message: 'Portfolio item not found' },
    });
    expect(set.status).toBe(404);
  });
});

const storedImage = {
  bucket: 'kuquest',
  objectKey: 'portfolio/student-1/new.png',
  contentType: 'image/png' as const,
  sizeBytes: 12,
};

const invokeReplaceImage = (
  params: { portfolioId: string; fileId?: string },
  request?: Request,
) => {
  const set: { status?: number | string } = {};

  return {
    result: replaceOwnPortfolioImage({
      body: { image: png('new.png') },
      params: params as never,
      request: request as never,
      session: session as never,
      set: set as never,
    }),
    set,
  };
};

describe('replaceOwnPortfolioImage', () => {
  it('uploads the image and returns the new version when there is no previous image', async () => {
    spyOn(portfolioStorage, 'upload').mockResolvedValue(storedImage);
    spyOn(portfolioService, 'replacePortfolioImage').mockResolvedValue({
      fileId: fileIdOne,
      previousFileId: null,
      previousBucket: null,
      previousObjectKey: null,
      version: 2,
    });

    const { result, set } = invokeReplaceImage({ portfolioId });

    expect(await result).toEqual({ success: true, data: { version: 2 } });
    expect(set.status).toBeUndefined();
    expect(portfolioService.replacePortfolioImage).toHaveBeenCalledWith(
      studentAuthId,
      portfolioId,
      storedImage,
      undefined,
      undefined,
    );
  });

  it('removes the previous image only after storing its replacement', async () => {
    spyOn(portfolioStorage, 'upload').mockResolvedValue(storedImage);
    spyOn(portfolioService, 'replacePortfolioImage').mockResolvedValue({
      fileId: fileIdTwo,
      previousFileId: fileIdOne,
      previousBucket: 'kuquest',
      previousObjectKey: 'portfolio/a.png',
      version: 3,
    });
    const deleteObject = spyOn(portfolioStorage, 'delete').mockResolvedValue();
    const markDeleted = spyOn(portfolioService, 'markPortfolioImageDeleted').mockResolvedValue();

    const { result, set } = invokeReplaceImage({ portfolioId, fileId: fileIdOne });

    expect(await result).toEqual({ success: true, data: { version: 3 } });
    expect(set.status).toBeUndefined();
    expect(portfolioService.replacePortfolioImage).toHaveBeenCalledWith(
      studentAuthId,
      portfolioId,
      storedImage,
      fileIdOne,
      undefined,
    );
    expect(deleteObject).toHaveBeenCalledWith('kuquest', 'portfolio/a.png');
    expect(markDeleted).toHaveBeenCalledWith(studentAuthId, fileIdOne);
  });

  it('discards the upload and reports a missing or unowned entry as not found', async () => {
    spyOn(portfolioStorage, 'upload').mockResolvedValue(storedImage);
    spyOn(portfolioService, 'replacePortfolioImage').mockResolvedValue({ outcome: 'not-found' });
    const deleteObject = spyOn(portfolioStorage, 'delete').mockResolvedValue();

    const { result, set } = invokeReplaceImage({ portfolioId });

    expect(await result).toEqual({
      success: false,
      error: { code: 'PORTFOLIO_NOT_FOUND', message: 'Portfolio item not found' },
    });
    expect(set.status).toBe(404);
    expect(deleteObject).toHaveBeenCalledWith(storedImage.bucket, storedImage.objectKey);
  });

  it('rejects an invalid resource version header without uploading anything', async () => {
    const upload = spyOn(portfolioStorage, 'upload');
    const request = new Request('http://localhost/x', { headers: { 'if-match': 'not-a-number' } });

    const { result, set } = invokeReplaceImage({ portfolioId }, request);

    expect(await result).toEqual({
      success: false,
      error: { code: 'INVALID_VERSION', message: 'Resource version must be a positive integer' },
    });
    expect(set.status).toBe(400);
    expect(upload).not.toHaveBeenCalled();
  });
});

const invokeDeleteImage = (params: { portfolioId: string; fileId?: string }) => {
  const set: { status?: number | string } = {};

  return {
    result: deleteOwnPortfolioImage({
      params: params as never,
      request: undefined as never,
      session: session as never,
      set: set as never,
    }),
    set,
  };
};

describe('deleteOwnPortfolioImage', () => {
  it('deletes the stored image and returns the new version', async () => {
    spyOn(portfolioService, 'deletePortfolioImage').mockResolvedValue({
      outcome: 'deleted',
      bucket: 'kuquest',
      objectKey: 'portfolio/a.png',
      version: 2,
    });
    const deleteObject = spyOn(portfolioStorage, 'delete').mockResolvedValue();

    const { result, set } = invokeDeleteImage({ portfolioId, fileId: fileIdOne });

    expect(await result).toEqual({ success: true, data: { version: 2 } });
    expect(set.status).toBeUndefined();
    expect(deleteObject).toHaveBeenCalledWith('kuquest', 'portfolio/a.png');
    expect(portfolioService.deletePortfolioImage).toHaveBeenCalledWith(
      studentAuthId,
      portfolioId,
      fileIdOne,
      undefined,
    );
  });

  it('reports a missing or unowned entry as not found', async () => {
    spyOn(portfolioService, 'deletePortfolioImage').mockResolvedValue({ outcome: 'not-found' });

    const { result, set } = invokeDeleteImage({ portfolioId });

    expect(await result).toEqual({
      success: false,
      error: { code: 'PORTFOLIO_NOT_FOUND', message: 'Portfolio item not found' },
    });
    expect(set.status).toBe(404);
  });

  it('reports a version conflict', async () => {
    spyOn(portfolioService, 'deletePortfolioImage').mockResolvedValue({ outcome: 'conflict' });

    const { result, set } = invokeDeleteImage({ portfolioId });

    expect(await result).toEqual({
      success: false,
      error: { code: 'CONFLICT', message: 'Portfolio was changed by another request' },
    });
    expect(set.status).toBe(409);
  });
});

const versioned = (version: string) =>
  new Request('http://localhost/x', { headers: { 'if-match': version } });

describe('replaceOwnPortfolioImage version and failure handling', () => {
  it('reports a version conflict and discards the freshly uploaded object', async () => {
    spyOn(portfolioStorage, 'upload').mockResolvedValue(storedImage);
    spyOn(portfolioService, 'replacePortfolioImage').mockResolvedValue({ outcome: 'conflict' });
    const deleteObject = spyOn(portfolioStorage, 'delete').mockResolvedValue();

    const { result, set } = invokeReplaceImage({ portfolioId });

    expect(await result).toEqual({
      success: false,
      error: { code: 'CONFLICT', message: 'Portfolio was changed by another request' },
    });
    expect(set.status).toBe(409);
    expect(deleteObject).toHaveBeenCalledWith(storedImage.bucket, storedImage.objectKey);
  });

  it('forwards the requested resource version to the service', async () => {
    spyOn(portfolioStorage, 'upload').mockResolvedValue(storedImage);
    spyOn(portfolioService, 'replacePortfolioImage').mockResolvedValue({
      fileId: fileIdOne,
      previousFileId: null,
      previousBucket: null,
      previousObjectKey: null,
      version: 4,
    });

    const { result } = invokeReplaceImage({ portfolioId }, versioned('"3"'));

    expect(await result).toEqual({ success: true, data: { version: 4 } });
    expect(portfolioService.replacePortfolioImage).toHaveBeenCalledWith(
      studentAuthId,
      portfolioId,
      storedImage,
      undefined,
      3,
    );
  });

  it('maps an oversized image to 413 without touching the entry', async () => {
    spyOn(portfolioStorage, 'upload').mockRejectedValue(
      new ImageTooLargeError('Image must be 5 MB or smaller'),
    );
    const replace = spyOn(portfolioService, 'replacePortfolioImage');

    const { result, set } = invokeReplaceImage({ portfolioId });

    expect(await result).toEqual({
      success: false,
      error: { code: 'IMAGE_TOO_LARGE', message: 'Image must be 5 MB or smaller' },
    });
    expect(set.status).toBe(413);
    expect(replace).not.toHaveBeenCalled();
  });

  it('hides the storage detail behind IMAGE_UPLOAD_FAILED', async () => {
    spyOn(portfolioStorage, 'upload').mockRejectedValue(
      new ImageUploadError('secret storage detail'),
    );

    const { result, set } = invokeReplaceImage({ portfolioId });
    const body = await result;

    expect(set.status).toBe(502);
    expect(body).toEqual({
      success: false,
      error: { code: 'IMAGE_UPLOAD_FAILED', message: 'Image upload failed' },
    });
    expect(JSON.stringify(body)).not.toContain('secret storage detail');
  });

  it('still reports success when removing the previous image fails', async () => {
    spyOn(portfolioStorage, 'upload').mockResolvedValue(storedImage);
    spyOn(portfolioService, 'replacePortfolioImage').mockResolvedValue({
      fileId: fileIdTwo,
      previousFileId: fileIdOne,
      previousBucket: 'kuquest',
      previousObjectKey: 'portfolio/a.png',
      version: 3,
    });
    spyOn(portfolioStorage, 'delete').mockRejectedValue(new Error('object storage down'));
    const markDeleted = spyOn(portfolioService, 'markPortfolioImageDeleted').mockResolvedValue();

    const { result, set } = invokeReplaceImage({ portfolioId, fileId: fileIdOne });

    expect(await result).toEqual({ success: true, data: { version: 3 } });
    expect(set.status).toBeUndefined();
    expect(markDeleted).not.toHaveBeenCalled();
  });

  it('discards the uploaded object and rethrows when the entry cannot be read', async () => {
    spyOn(portfolioStorage, 'upload').mockResolvedValue(storedImage);
    spyOn(portfolioService, 'replacePortfolioImage').mockRejectedValue(new Error('db down'));
    const deleteObject = spyOn(portfolioStorage, 'delete').mockResolvedValue();

    const { result } = invokeReplaceImage({ portfolioId });

    await expect(result).rejects.toThrow('db down');
    expect(deleteObject).toHaveBeenCalledWith(storedImage.bucket, storedImage.objectKey);
  });
});

const invokeDeleteImageWith = (
  params: { portfolioId: string; fileId?: string },
  request?: Request,
) => {
  const set: { status?: number | string } = {};

  return {
    result: deleteOwnPortfolioImage({
      params: params as never,
      request: request as never,
      session: session as never,
      set: set as never,
    }),
    set,
  };
};

describe('deleteOwnPortfolioImage version and failure handling', () => {
  it('forwards the requested resource version to the service', async () => {
    spyOn(portfolioService, 'deletePortfolioImage').mockResolvedValue({
      outcome: 'deleted',
      bucket: 'kuquest',
      objectKey: 'portfolio/a.png',
      version: 5,
    });
    spyOn(portfolioStorage, 'delete').mockResolvedValue();

    const { result } = invokeDeleteImageWith({ portfolioId, fileId: fileIdOne }, versioned('4'));

    expect(await result).toEqual({ success: true, data: { version: 5 } });
    expect(portfolioService.deletePortfolioImage).toHaveBeenCalledWith(
      studentAuthId,
      portfolioId,
      fileIdOne,
      4,
    );
  });

  it('rejects an invalid resource version header without touching the entry', async () => {
    const deletePortfolioImage = spyOn(portfolioService, 'deletePortfolioImage');

    const { result, set } = invokeDeleteImageWith({ portfolioId }, versioned('not-a-number'));

    expect(await result).toEqual({
      success: false,
      error: { code: 'INVALID_VERSION', message: 'Resource version must be a positive integer' },
    });
    expect(set.status).toBe(400);
    expect(deletePortfolioImage).not.toHaveBeenCalled();
  });

  it('reports the removal as done even when the object cannot be deleted', async () => {
    spyOn(portfolioService, 'deletePortfolioImage').mockResolvedValue({
      outcome: 'deleted',
      bucket: 'kuquest',
      objectKey: 'portfolio/a.png',
      version: 2,
    });
    spyOn(portfolioStorage, 'delete').mockRejectedValue(new Error('object storage down'));

    const { result, set } = invokeDeleteImageWith({ portfolioId, fileId: fileIdOne });

    expect(await result).toEqual({ success: true, data: { version: 2 } });
    expect(set.status).toBeUndefined();
  });
});
