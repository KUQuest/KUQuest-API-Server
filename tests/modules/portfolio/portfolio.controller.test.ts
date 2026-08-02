import {
  createOwnPortfolio,
  deleteOwnPortfolio,
  listOwnPortfolio,
  updateOwnPortfolio,
} from '@/modules/portfolio/portfolio.controller';
import * as portfolioService from '@/modules/portfolio/portfolio.service';
import {
  PortfolioImageUploadError,
  portfolioStorage,
  UnsupportedPortfolioImageTypeError,
} from '@/modules/portfolio/portfolio.storage';

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
        new UnsupportedPortfolioImageTypeError('Image must be a valid JPEG, PNG, or WebP file'),
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
      new PortfolioImageUploadError('secret storage detail'),
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
    });
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
    });
    const deleteObject = spyOn(portfolioStorage, 'delete').mockResolvedValue();
    const markDeleted = spyOn(portfolioService, 'markPortfolioImageDeleted').mockResolvedValue();

    const { result, set } = invokeDelete();

    expect(await result).toEqual({ success: true });
    expect(set.status).toBeUndefined();
    expect(deleteObject).toHaveBeenCalledWith('kuquest', 'portfolio/a.png');
    expect(markDeleted).toHaveBeenCalledWith(studentAuthId, fileIdOne);
  });

  it('still reports success when storage cleanup for an image fails', async () => {
    spyOn(portfolioService, 'deletePortfolio').mockResolvedValue({
      outcome: 'deleted',
      images: [{ fileId: fileIdOne, bucket: 'kuquest', objectKey: 'portfolio/a.png' }],
    });
    spyOn(portfolioStorage, 'delete').mockRejectedValue(new Error('object storage down'));

    const { result, set } = invokeDelete();

    expect(await result).toEqual({ success: true });
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
