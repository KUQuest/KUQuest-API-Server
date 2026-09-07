import {
  ImageTooLargeError,
  ImageUploadError,
  UnsupportedImageTypeError,
  createImageStorage,
} from '@/shared/image-storage';

import { describe, expect, it } from 'bun:test';
import sharp from 'sharp';

const storage = createImageStorage({ keyPrefix: 'test-images' });

const validPngBuffer = () =>
  sharp({ create: { width: 1, height: 1, channels: 3, background: { r: 255, g: 0, b: 0 } } })
    .png()
    .toBuffer();

const validGifBuffer = () =>
  sharp({ create: { width: 1, height: 1, channels: 3, background: { r: 0, g: 255, b: 0 } } })
    .gif()
    .toBuffer();

describe('createImageStorage upload validation', () => {
  it('rejects an empty file', async () => {
    const file = new File([], 'empty.png', { type: 'image/png' });

    await expect(storage.upload('user-1', file)).rejects.toThrow(UnsupportedImageTypeError);
  });

  it('rejects a file over the size limit', async () => {
    const oversized = new Uint8Array(5 * 1024 * 1024 + 1);
    const file = new File([oversized], 'big.png', { type: 'image/png' });

    await expect(storage.upload('user-1', file)).rejects.toThrow(ImageTooLargeError);
  });

  it('rejects a file the decoder cannot understand', async () => {
    const file = new File([new TextEncoder().encode('not an image')], 'fake.png', {
      type: 'image/png',
    });

    await expect(storage.upload('user-1', file)).rejects.toThrow(UnsupportedImageTypeError);
  });

  it('rejects a declared content type that does not match the detected image format', async () => {
    const buffer = await validPngBuffer();
    const file = new File([buffer], 'mismatch.jpg', { type: 'image/jpeg' });

    await expect(storage.upload('user-1', file)).rejects.toThrow(UnsupportedImageTypeError);
  });

  it('rejects a valid image of an unsupported content type', async () => {
    const buffer = await validGifBuffer();
    const file = new File([buffer], 'valid.gif', { type: 'image/gif' });

    await expect(storage.upload('user-1', file)).rejects.toThrow(UnsupportedImageTypeError);
  });
});

describe('createImageStorage upload size limit', () => {
  it('honors a configured maxSizeBytes override', async () => {
    const small = createImageStorage({ keyPrefix: 'test-images', maxSizeBytes: 10 });
    const file = new File([new Uint8Array(11)], 'small.png', { type: 'image/png' });

    await expect(small.upload('user-1', file)).rejects.toThrow(ImageTooLargeError);
  });

  it('checks the actual byte length after reading the file', async () => {
    const small = createImageStorage({ keyPrefix: 'test-images', maxSizeBytes: 10 });
    const file = {
      name: 'small.png',
      type: 'image/png',
      size: 1,
      arrayBuffer: async () => new Uint8Array(11).buffer,
    } as File;

    await expect(small.upload('user-1', file)).rejects.toThrow(ImageTooLargeError);
  });
});

describe('createImageStorage upload plans', () => {
  it('writes an upload to its prepared object target', async () => {
    let writtenObjectKey: string | undefined;
    const bytes = await validPngBuffer();
    const plannedStorage = createImageStorage({
      keyPrefix: 'planned-images',
      bucket: 'kuquest-test',
      client: {
        write: async (objectKey) => {
          writtenObjectKey = objectKey;
          return bytes.length;
        },
        delete: async () => undefined,
        presign: () => 'https://storage.test/signed-link',
      },
    });
    const plan = plannedStorage.prepareUpload('user-1');

    const stored = await plannedStorage.upload(
      'user-1',
      new File([bytes], 'image.png', { type: 'image/png' }),
      plan,
    );

    expect(writtenObjectKey).toBe(plan.objectKey);
    expect(stored).toEqual({
      ...plan,
      contentType: 'image/png',
      sizeBytes: bytes.length,
    });
  });
});

describe('createImageStorage temporary links', () => {
  it('returns a link expiry that matches the presign lifetime', () => {
    let expiresIn: number | undefined;
    const linkedStorage = createImageStorage({
      keyPrefix: 'linked-images',
      bucket: 'kuquest-test',
      client: {
        write: async () => 0,
        delete: async () => undefined,
        presign: (_objectKey, options) => {
          expiresIn = options?.expiresIn;
          return 'https://storage.test/temporary-link';
        },
      },
    });
    const before = Date.now();

    const link = linkedStorage.linkForWithExpiry({
      bucket: 'kuquest-test',
      objectKey: 'linked-images/user-1/image.png',
    });

    expect(link.url).toBe('https://storage.test/temporary-link');
    expect(expiresIn).toBe(15 * 60);
    expect(link.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 15 * 60 * 1000);
    expect(link.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 15 * 60 * 1000);
  });
});

describe('createImageStorage upload compensation', () => {
  it('deletes the generated object when storage write fails', async () => {
    const deleted: string[] = [];
    const partialStorage = createImageStorage({
      keyPrefix: 'partial-upload',
      bucket: 'kuquest-test',
      client: {
        write: async () => {
          throw new Error('write failed');
        },
        delete: async (objectKey) => {
          deleted.push(objectKey);
        },
        presign: () => 'https://storage.test/signed-link',
      },
    });
    const file = new File([await validPngBuffer()], 'image.png', { type: 'image/png' });

    await expect(partialStorage.upload('user-1', file)).rejects.toBeInstanceOf(ImageUploadError);
    expect(deleted).toHaveLength(1);
    expect(deleted[0]).toMatch(/^partial-upload\/user-1\/.+\.png$/);
  });
});
