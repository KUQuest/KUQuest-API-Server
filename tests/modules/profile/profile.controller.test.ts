import { db } from '@/database/client';
import { getOwnProfile, setAvatar, updateOwnProfile } from '@/modules/profile/profile.controller';
import * as profileService from '@/modules/profile/profile.service';
import {
  AvatarLinkUnavailableError,
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

const storedProfile = {
  email: 'student@ku.th',
  firstName: 'Student',
  lastName: 'One',
  bio: null,
  telephone: null,
  studentId: null,
  academicYear: null,
  major: null,
  avatar: null,
};

const storedAvatar = {
  fileId,
  bucket: 'kuquest',
  objectKey: `avatars/${studentAuthId}/current.png`,
};

const invokeGetOwnProfile = () => {
  const set: { status?: number | string } = {};

  return { result: getOwnProfile({ session: session as never, set: set as never }), set };
};

const invokeUpdateOwnProfile = (body: Record<string, unknown> = { bio: 'a new bio' }) => {
  const set: { status?: number | string } = {};

  return {
    result: updateOwnProfile({
      body: body as never,
      session: session as never,
      set: set as never,
    }),
    set,
  };
};

describe('getOwnProfile', () => {
  it('turns a stored avatar reference into a link that expires', async () => {
    spyOn(profileService, 'getProfile').mockResolvedValue({
      ...storedProfile,
      avatar: storedAvatar,
    });
    spyOn(avatarStorage, 'linkFor').mockReturnValue('https://storage.test/signed-link');

    const { result, set } = invokeGetOwnProfile();

    expect(await result).toEqual({
      success: true,
      data: { ...storedProfile, avatar: { fileId, url: 'https://storage.test/signed-link' } },
    });
    expect(set.status).toBeUndefined();
    expect(avatarStorage.linkFor).toHaveBeenCalledWith(storedAvatar);
  });

  it('reports no avatar when the student has none, without asking storage', async () => {
    spyOn(profileService, 'getProfile').mockResolvedValue(storedProfile);
    spyOn(avatarStorage, 'linkFor');

    const { result } = invokeGetOwnProfile();

    expect((await result) as { data: { avatar: unknown } }).toHaveProperty('data.avatar', null);
    expect(avatarStorage.linkFor).not.toHaveBeenCalled();
  });

  it('still answers with the profile when the avatar link cannot be built', async () => {
    spyOn(profileService, 'getProfile').mockResolvedValue({
      ...storedProfile,
      avatar: storedAvatar,
    });
    spyOn(avatarStorage, 'linkFor').mockImplementation(() => {
      throw new AvatarLinkUnavailableError('Object storage is not configured');
    });

    const { result, set } = invokeGetOwnProfile();

    expect(await result).toEqual({ success: true, data: storedProfile });
    expect(set.status).toBeUndefined();
  });

  it('reports a missing student as not found rather than a server fault', async () => {
    spyOn(profileService, 'getProfile').mockResolvedValue(undefined);

    const { result, set } = invokeGetOwnProfile();
    const body = await result;

    expect(set.status).toBe(404);
    expect(body).toEqual({
      success: false,
      error: { code: 'USER_NOT_FOUND', message: 'User not found' },
    });
  });
});

describe('updateOwnProfile', () => {
  it('answers a completed update without echoing the profile back', async () => {
    spyOn(profileService, 'updateProfile').mockResolvedValue('updated');

    const { result, set } = invokeUpdateOwnProfile();

    expect(await result).toEqual({ success: true });
    expect(set.status).toBeUndefined();
    expect(profileService.updateProfile).toHaveBeenCalledWith(studentAuthId, {
      bio: 'a new bio',
    });
  });

  it('reports a missing student as not found', async () => {
    spyOn(profileService, 'updateProfile').mockResolvedValue('student-not-found');

    const { result, set } = invokeUpdateOwnProfile();
    const body = await result;

    expect(set.status).toBe(404);
    expect(body).toEqual({
      success: false,
      error: { code: 'USER_NOT_FOUND', message: 'User not found' },
    });
  });

  it('reports an unknown major as the caller mistake it is', async () => {
    spyOn(profileService, 'updateProfile').mockResolvedValue('major-not-found');

    const { result, set } = invokeUpdateOwnProfile({
      majorId: '018f47a7-1c7d-7c98-9a11-690d7e834300',
    });
    const body = await result;

    expect(set.status).toBe(400);
    expect(body).toEqual({
      success: false,
      error: { code: 'MAJOR_NOT_FOUND', message: 'Major not found' },
    });
  });
});
