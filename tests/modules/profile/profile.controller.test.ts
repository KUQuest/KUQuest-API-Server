import { db } from '@/database/client';
import { setAvatar } from '@/modules/profile/profile.controller';
import {
  AvatarUploadError,
  avatarStorage,
} from '@/modules/profile/profile.storage';

import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';

const studentAuthId = 'student-1';
const fileId = '018f47a7-1c7d-7c98-9a11-690d7e83430c';
const previousFileId = '018f47a7-1c7d-7c98-9a11-690d7e83430d';

const session = {
  user: {
    id: studentAuthId,
  },
};

const invokeSetAvatar = (avatar: File) => {
  const set: { status?: number | string } = {};

  return {
    result: setAvatar({
      body: { avatar },
      session: session as never,
      set: set as never,
    }),
    set,
  };
};

afterEach(() => {
  mock.restore();
});

describe('setAvatar', () => {
  it('returns only the stored file reference', async () => {
    const storedAvatar = {
      bucket: 'kuquest',
      objectKey: `avatars/${studentAuthId}/avatar.png`,
      contentType: 'image/png' as const,
      sizeBytes: 12,
    };
    spyOn(avatarStorage, 'upload').mockResolvedValue(storedAvatar);
    spyOn(db, 'transaction').mockResolvedValue({
      fileId,
      previousFileId: null,
    });

    const { result, set } = invokeSetAvatar(
      new File(['image-content'], 'avatar.png', { type: 'image/png' }),
    );

    expect(await result).toEqual({
      success: true,
      data: { fileId },
    });
    expect(set.status).toBeUndefined();
    expect(avatarStorage.upload).toHaveBeenCalledWith(
      studentAuthId,
      expect.any(File),
    );
  });

  it('removes the previous avatar only after storing its replacement', async () => {
    spyOn(avatarStorage, 'upload').mockResolvedValue({
      bucket: 'kuquest',
      objectKey: `avatars/${studentAuthId}/new.png`,
      contentType: 'image/png',
      sizeBytes: 12,
    });
    spyOn(db, 'transaction').mockResolvedValue({
      fileId,
      previousFileId,
    });
    const limit = mock(async () => [{
      bucket: 'old-avatar-bucket',
      objectKey: `avatars/${studentAuthId}/old.png`,
    }]);
    spyOn(db, 'select').mockReturnValue({
      from: mock(() => ({
        where: mock(() => ({ limit })),
      })),
    } as never);
    const markDeleted = mock(async () => undefined);
    spyOn(db, 'update').mockReturnValue({
      set: mock(() => ({ where: markDeleted })),
    } as never);
    const deleteObject = spyOn(avatarStorage, 'delete').mockResolvedValue();

    const { result } = invokeSetAvatar(
      new File(['image-content'], 'avatar.png', { type: 'image/png' }),
    );

    expect(await result).toEqual({
      success: true,
      data: { fileId },
    });
    expect(limit).toHaveBeenCalledTimes(1);
    expect(avatarStorage.delete).toHaveBeenCalledWith(
      'old-avatar-bucket',
      `avatars/${studentAuthId}/old.png`,
    );
    expect(markDeleted).toHaveBeenCalledTimes(1);
    expect(deleteObject.mock.invocationCallOrder[0]).toBeLessThan(
      markDeleted.mock.invocationCallOrder[0],
    );
  });

  it('rejects an avatar larger than 5 MB', async () => {
    const avatar = new File(
      [new Uint8Array(5 * 1024 * 1024 + 1)],
      'avatar.png',
      { type: 'image/png' },
    );

    const { result, set } = invokeSetAvatar(avatar);

    expect(await result).toEqual({
      success: false,
      error: {
        code: 'AVATAR_TOO_LARGE',
        message: 'Avatar must be 5 MB or smaller',
      },
    });
    expect(set.status).toBe(413);
  });

  it('rejects truncated content with a supported signature', async () => {
    const truncatedPng = new File(
      [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
      'avatar.png',
      { type: 'image/png' },
    );

    const { result, set } = invokeSetAvatar(truncatedPng);

    expect(await result).toEqual({
      success: false,
      error: {
        code: 'UNSUPPORTED_AVATAR_TYPE',
        message: 'Avatar must be a valid JPEG, PNG, or WebP image',
      },
    });
    expect(set.status).toBe(415);
  });

  it('returns a safe error when object storage rejects the upload', async () => {
    spyOn(avatarStorage, 'upload').mockRejectedValue(
      new AvatarUploadError('secret RustFS detail'),
    );

    const { result, set } = invokeSetAvatar(
      new File(['image-content'], 'avatar.png', { type: 'image/png' }),
    );
    const body = await result;

    expect(set.status).toBe(502);
    expect(body).toEqual({
      success: false,
      error: {
        code: 'AVATAR_UPLOAD_FAILED',
        message: 'Avatar upload failed',
      },
    });
    expect(JSON.stringify(body)).not.toContain('secret RustFS detail');
  });
});
