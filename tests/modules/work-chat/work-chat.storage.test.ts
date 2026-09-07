import {
  UnsupportedWorkChatAttachmentError,
  WorkChatAttachmentTooLargeError,
  WorkChatAttachmentUploadError,
  createWorkChatStorage,
} from '@/modules/work-chat/work-chat.storage';

import { describe, expect, it } from 'bun:test';
import sharp from 'sharp';

const validPngBuffer = () => sharp({
  create: { width: 1, height: 1, channels: 3, background: { r: 255, g: 0, b: 0 } },
}).png().toBuffer();

describe('Work Chat attachment storage', () => {
  it('validates and stores a supported image', async () => {
    const png = await validPngBuffer();
    const writes: Array<{ key: string; type?: string }> = [];
    const storage = createWorkChatStorage({
      keyPrefix: 'test-work-chat',
      bucket: 'kuquest-test',
      client: {
        write: async (key, _value, options) => {
          writes.push({ key, type: options?.type });
          return png.byteLength;
        },
        delete: async () => {},
        presign: () => 'https://storage.test/signed-link',
      },
    });

    const attachment = await storage.upload(
      'member-1',
      new File([png], '../proof.png', { type: 'image/png' }),
    );

    expect(attachment).toMatchObject({
      bucket: 'kuquest-test',
      contentType: 'image/png',
      fileName: 'proof.png',
    });
    expect(writes[0]).toMatchObject({ type: 'image/png' });
    expect(writes[0]?.key).toMatch(/^test-work-chat\/member-1\/.+\.png$/);
  });

  it('rejects unsupported and mismatched content', async () => {
    const storage = createWorkChatStorage({
      keyPrefix: 'test-work-chat',
      bucket: 'kuquest-test',
      client: { write: async () => 0, delete: async () => {}, presign: () => '' },
    });

    await expect(storage.upload('member-1', new File([new TextEncoder().encode('not a png')], 'fake.png', {
      type: 'image/png',
    }))).rejects.toBeInstanceOf(UnsupportedWorkChatAttachmentError);
    await expect(storage.upload('member-1', new File([await validPngBuffer()], 'mismatch.jpg', {
      type: 'image/jpeg',
    }))).rejects.toBeInstanceOf(UnsupportedWorkChatAttachmentError);
  });

  it('enforces the configured size limit before decoding', async () => {
    const storage = createWorkChatStorage({
      keyPrefix: 'test-work-chat',
      bucket: 'kuquest-test',
      maxSizeBytes: 3,
      client: { write: async () => 0, delete: async () => {}, presign: () => '' },
    });

    await expect(storage.upload('member-1', new File([new Uint8Array(4)], 'large.png', {
      type: 'image/png',
    }))).rejects.toBeInstanceOf(WorkChatAttachmentTooLargeError);
  });

  it('compensates for an object write failure', async () => {
    const deleted: string[] = [];
    const storage = createWorkChatStorage({
      keyPrefix: 'test-work-chat',
      bucket: 'kuquest-test',
      client: {
        write: async () => { throw new Error('write failed'); },
        delete: async (key) => { deleted.push(key); },
        presign: () => '',
      },
    });

    await expect(storage.upload(
      'member-1',
      new File([await validPngBuffer()], 'image.png', { type: 'image/png' }),
    )).rejects.toBeInstanceOf(WorkChatAttachmentUploadError);
    expect(deleted).toHaveLength(1);
    expect(deleted[0]).toMatch(/^test-work-chat\/member-1\/.+\.png$/);
  });
});
