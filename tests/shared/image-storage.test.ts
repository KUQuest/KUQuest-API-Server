import { ImageTooLargeError, UnsupportedImageTypeError, createImageStorage } from '@/shared/image-storage';

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
});
