import {
  FileLinkUnavailableError,
  FileTooLargeError,
  FileUploadError,
  ImageLinkUnavailableError,
  ImageTooLargeError,
  ImageUploadError,
  UnsupportedFileTypeError,
  UnsupportedImageTypeError,
  createObjectStorage,
} from '@/shared/object-storage';

import { describe, expect, it } from 'bun:test';
import sharp from 'sharp';

const validPngBuffer = () =>
  sharp({ create: { width: 1, height: 1, channels: 3, background: { r: 255, g: 0, b: 0 } } })
    .png()
    .toBuffer();

const validGifBuffer = () =>
  sharp({ create: { width: 1, height: 1, channels: 3, background: { r: 0, g: 255, b: 0 } } })
    .gif()
    .toBuffer();

const storage = createObjectStorage({ keyPrefix: 'test-images', policy: 'image-only' });

describe('object storage image-only policy', () => {
  it('rejects an empty file', async () => {
    const file = new File([], 'empty.png', { type: 'image/png' });

    await expect(storage.upload('user-1', file)).rejects.toThrow(UnsupportedFileTypeError);
  });

  it('rejects a file over the 5 MB default size limit', async () => {
    const oversized = new Uint8Array(5 * 1024 * 1024 + 1);
    const file = new File([oversized], 'big.png', { type: 'image/png' });

    await expect(storage.upload('user-1', file)).rejects.toBeInstanceOf(FileTooLargeError);
  });

  it('rejects a file the decoder cannot understand', async () => {
    const file = new File([new TextEncoder().encode('not an image')], 'fake.png', {
      type: 'image/png',
    });

    await expect(storage.upload('user-1', file)).rejects.toThrow(UnsupportedFileTypeError);
  });

  it('rejects a declared content type that does not match the detected image format', async () => {
    const buffer = await validPngBuffer();
    const file = new File([buffer], 'mismatch.jpg', { type: 'image/jpeg' });

    await expect(storage.upload('user-1', file)).rejects.toThrow(UnsupportedFileTypeError);
  });

  it('rejects a valid image of an unsupported content type', async () => {
    const buffer = await validGifBuffer();
    const file = new File([buffer], 'valid.gif', { type: 'image/gif' });

    await expect(storage.upload('user-1', file)).rejects.toThrow(UnsupportedFileTypeError);
  });

  it('honors a configured maxSizeBytes override', async () => {
    const small = createObjectStorage({
      keyPrefix: 'test-images',
      policy: 'image-only',
      maxSizeBytes: 10,
    });
    const file = new File([new Uint8Array(11)], 'small.png', { type: 'image/png' });

    await expect(small.upload('user-1', file)).rejects.toBeInstanceOf(FileTooLargeError);
  });

  it('checks the actual byte length after reading the file', async () => {
    const small = createObjectStorage({
      keyPrefix: 'test-images',
      policy: 'image-only',
      maxSizeBytes: 10,
    });
    const file = {
      name: 'small.png',
      type: 'image/png',
      size: 1,
      arrayBuffer: async () => new Uint8Array(11).buffer,
    } as File;

    await expect(small.upload('user-1', file)).rejects.toBeInstanceOf(FileTooLargeError);
  });

  it('accepts valid JPEG and WebP images', async () => {
    let written = 0;
    const acceptStorage = createObjectStorage({
      keyPrefix: 'test-images',
      policy: 'image-only',
      bucket: 'kuquest-test',
      client: {
        write: async () => written,
        delete: async () => undefined,
        presign: () => 'https://storage.test/signed-link',
      },
    });

    const jpeg = await sharp({
      create: { width: 1, height: 1, channels: 3, background: { r: 0, g: 0, b: 255 } },
    })
      .jpeg()
      .toBuffer();
    written = jpeg.byteLength;
    const storedJpeg = await acceptStorage.upload(
      'user-1',
      new File([jpeg], 'photo.jpg', { type: 'image/jpeg' })
    );
    expect(storedJpeg).toMatchObject({ contentType: 'image/jpeg', sizeBytes: jpeg.byteLength });

    const webp = await sharp({
      create: { width: 1, height: 1, channels: 3, background: { r: 0, g: 0, b: 255 } },
    })
      .webp()
      .toBuffer();
    written = webp.byteLength;
    const storedWebp = await acceptStorage.upload(
      'user-1',
      new File([webp], 'photo.webp', { type: 'image/webp' })
    );
    expect(storedWebp).toMatchObject({ contentType: 'image/webp', sizeBytes: webp.byteLength });
  });

  it('keeps the Image error aliases pointing at the canonical errors', () => {
    expect(ImageTooLargeError).toBe(FileTooLargeError);
    expect(UnsupportedImageTypeError).toBe(UnsupportedFileTypeError);
    expect(ImageUploadError).toBe(FileUploadError);
    expect(ImageLinkUnavailableError).toBe(FileLinkUnavailableError);
  });
});

describe('object storage upload plans', () => {
  it('writes an upload to its prepared object target', async () => {
    let writtenObjectKey: string | undefined;
    const bytes = await validPngBuffer();
    const plannedStorage = createObjectStorage({
      keyPrefix: 'planned-images',
      policy: 'image-only',
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
      plan
    );

    expect(writtenObjectKey).toBe(plan.objectKey);
    expect(stored).toEqual({
      ...plan,
      contentType: 'image/png',
      sizeBytes: bytes.length,
      fileName: 'image.png',
    });
  });
});

describe('object storage temporary links', () => {
  it('returns a link expiry that matches the presign lifetime', () => {
    let expiresIn: number | undefined;
    const linkedStorage = createObjectStorage({
      keyPrefix: 'linked-images',
      policy: 'image-only',
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

describe('object storage upload compensation', () => {
  it('deletes the generated object when storage write fails', async () => {
    const deleted: string[] = [];
    const partialStorage = createObjectStorage({
      keyPrefix: 'partial-upload',
      policy: 'image-only',
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

    await expect(partialStorage.upload('user-1', file)).rejects.toBeInstanceOf(FileUploadError);
    expect(deleted).toHaveLength(1);
    expect(deleted[0]).toMatch(/^partial-upload\/user-1\/.+\.png$/);
  });
});

const validPdfBytes = () => new TextEncoder().encode('%PDF-1.4 minimal pdf body');

const validMp4Bytes = () => {
  const bytes = new Uint8Array(16);
  bytes.set([0, 0, 0, 8], 0);
  bytes.set(new TextEncoder().encode('ftyp'), 4);
  bytes.set(new TextEncoder().encode('isom'), 8);
  return bytes;
};

const validWebmBytes = () => {
  const bytes = new Uint8Array(16);
  bytes.set([0x1a, 0x45, 0xdf, 0xa3], 0);
  return bytes;
};

describe('object storage image-pdf-video policy', () => {
  it('validates and stores a supported image with a sanitized file name', async () => {
    const writes: Array<{ key: string; type?: string }> = [];
    const png = await validPngBuffer();
    const attachmentStorage = createObjectStorage({
      keyPrefix: 'test-work-chat',
      policy: 'image-pdf-video',
      bucket: 'kuquest-test',
      client: {
        write: async (key, _value, options) => {
          writes.push({ key, type: options?.type });
          return png.byteLength;
        },
        delete: async () => undefined,
        presign: () => 'https://storage.test/signed-link',
      },
    });

    const attachment = await attachmentStorage.upload(
      'member-1',
      new File([png], '../proof.png', { type: 'image/png' })
    );

    expect(attachment).toMatchObject({
      bucket: 'kuquest-test',
      contentType: 'image/png',
      sizeBytes: png.byteLength,
      fileName: 'proof.png',
    });
    expect(writes[0]).toMatchObject({ type: 'image/png' });
    expect(writes[0]?.key).toMatch(/^test-work-chat\/member-1\/.+\.png$/);
  });

  it('accepts a valid PDF file', async () => {
    const pdf = validPdfBytes();
    const pdfStorage = createObjectStorage({
      keyPrefix: 'test-docs',
      policy: 'image-pdf-video',
      bucket: 'kuquest-test',
      client: {
        write: async (_key, _value, _options) => pdf.byteLength,
        delete: async () => undefined,
        presign: () => 'https://storage.test/signed-link',
      },
    });

    const stored = await pdfStorage.upload(
      'member-1',
      new File([pdf], 'doc.pdf', { type: 'application/pdf' })
    );

    expect(stored).toMatchObject({ contentType: 'application/pdf', sizeBytes: pdf.byteLength });
    expect(stored.objectKey).toMatch(/^test-docs\/member-1\/.+\.pdf$/);
  });

  it('accepts a valid MP4 file', async () => {
    const mp4 = validMp4Bytes();
    const videoStorage = createObjectStorage({
      keyPrefix: 'test-videos',
      policy: 'image-pdf-video',
      bucket: 'kuquest-test',
      client: {
        write: async (_key, _value, _options) => mp4.byteLength,
        delete: async () => undefined,
        presign: () => 'https://storage.test/signed-link',
      },
    });

    const stored = await videoStorage.upload(
      'member-1',
      new File([mp4], 'clip.mp4', { type: 'video/mp4' })
    );

    expect(stored).toMatchObject({ contentType: 'video/mp4', sizeBytes: mp4.byteLength });
    expect(stored.objectKey).toMatch(/^test-videos\/member-1\/.+\.mp4$/);
  });

  it('accepts a valid WebM file', async () => {
    const webm = validWebmBytes();
    const videoStorage = createObjectStorage({
      keyPrefix: 'test-videos',
      policy: 'image-pdf-video',
      bucket: 'kuquest-test',
      client: {
        write: async (_key, _value, _options) => webm.byteLength,
        delete: async () => undefined,
        presign: () => 'https://storage.test/signed-link',
      },
    });

    const stored = await videoStorage.upload(
      'member-1',
      new File([webm], 'clip.webm', { type: 'video/webm' })
    );

    expect(stored).toMatchObject({ contentType: 'video/webm', sizeBytes: webm.byteLength });
    expect(stored.objectKey).toMatch(/^test-videos\/member-1\/.+\.webm$/);
  });

  it('rejects text content declared as an image type', async () => {
    const videoStorage = createObjectStorage({
      keyPrefix: 'test-work-chat',
      policy: 'image-pdf-video',
      bucket: 'kuquest-test',
      client: { write: async () => 0, delete: async () => undefined, presign: () => '' },
    });

    await expect(
      videoStorage.upload(
        'member-1',
        new File([new TextEncoder().encode('not a png')], 'fake.png', {
          type: 'image/png',
        })
      )
    ).rejects.toBeInstanceOf(UnsupportedFileTypeError);
  });

  it('rejects an empty file', async () => {
    const videoStorage = createObjectStorage({
      keyPrefix: 'test-work-chat',
      policy: 'image-pdf-video',
      bucket: 'kuquest-test',
      client: { write: async () => 0, delete: async () => undefined, presign: () => '' },
    });

    await expect(
      videoStorage.upload('member-1', new File([], 'empty.png', { type: 'image/png' }))
    ).rejects.toBeInstanceOf(UnsupportedFileTypeError);
  });

  it('rejects a declared content type that does not match the detected content', async () => {
    const videoStorage = createObjectStorage({
      keyPrefix: 'test-work-chat',
      policy: 'image-pdf-video',
      bucket: 'kuquest-test',
      client: { write: async () => 0, delete: async () => undefined, presign: () => '' },
    });

    await expect(
      videoStorage.upload(
        'member-1',
        new File([await validPngBuffer()], 'mismatch.jpg', {
          type: 'image/jpeg',
        })
      )
    ).rejects.toBeInstanceOf(UnsupportedFileTypeError);
  });

  it('rejects a file with image magic bytes but corrupt image data', async () => {
    const videoStorage = createObjectStorage({
      keyPrefix: 'test-work-chat',
      policy: 'image-pdf-video',
      bucket: 'kuquest-test',
      client: { write: async () => 0, delete: async () => undefined, presign: () => '' },
    });
    const corruptPng = new Uint8Array(32);
    corruptPng.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
    corruptPng.set(new TextEncoder().encode('trailing garbage'), 8);

    await expect(
      videoStorage.upload('member-1', new File([corruptPng], 'corrupt.png', { type: 'image/png' }))
    ).rejects.toBeInstanceOf(UnsupportedFileTypeError);
  });

  it('enforces the 10 MB default size limit', async () => {
    const videoStorage = createObjectStorage({
      keyPrefix: 'test-work-chat',
      policy: 'image-pdf-video',
    });
    const oversized = new Uint8Array(10 * 1024 * 1024 + 1);
    const file = new File([oversized], 'large.mp4', { type: 'video/mp4' });

    await expect(videoStorage.upload('member-1', file)).rejects.toBeInstanceOf(FileTooLargeError);
  });

  it('enforces a configured size limit before decoding', async () => {
    const videoStorage = createObjectStorage({
      keyPrefix: 'test-work-chat',
      policy: 'image-pdf-video',
      maxSizeBytes: 3,
      client: { write: async () => 0, delete: async () => undefined, presign: () => '' },
    });

    await expect(
      videoStorage.upload(
        'member-1',
        new File([new Uint8Array(4)], 'large.png', {
          type: 'image/png',
        })
      )
    ).rejects.toBeInstanceOf(FileTooLargeError);
  });
});
