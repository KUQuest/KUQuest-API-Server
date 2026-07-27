import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';

import { app } from '@/app';
import { auth } from '@/modules/auth';
import { db } from '@/database/client';
import {
  AvatarUploadError,
  avatarStorage,
} from '@/modules/profile/profile.storage';

const studentId = 'student-1';
const fileId = '018f47a7-1c7d-7c98-9a11-690d7e83430c';

const authenticateStudent = () => {
  spyOn(auth.api, 'getSession').mockResolvedValue({
    session: {
      id: 'session-1',
      userId: studentId,
      expiresAt: new Date('2030-01-01T00:00:00.000Z'),
      token: 'session-token',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      ipAddress: null,
      userAgent: null,
    },
    user: {
      id: studentId,
      email: 'student@ku.th',
      emailVerified: true,
      firstName: 'Student',
      lastName: 'One',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      image: null,
    },
  } as never);
};

const avatarRequest = (avatar: File) => {
  const form = new FormData();
  form.set('avatar', avatar);

  return new Request('http://localhost/api/v1/profile/avatar', {
    method: 'POST',
    body: form,
  });
};

afterEach(() => {
  mock.restore();
});

describe('profile avatar integration', () => {
  it('requires authentication before accepting an avatar', async () => {
    const response = await app.handle(
      avatarRequest(
        new File(['not-an-image'], 'avatar.png', { type: 'image/png' }),
      ),
    );
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body).toEqual({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Unauthorized' },
    });
  });

  it('documents the authenticated multipart avatar endpoint', async () => {
    const response = await app.handle(
      new Request('http://localhost/openapi/json'),
    );
    const document = await response.json() as {
      paths?: Record<string, Record<string, {
        requestBody?: {
          content?: Record<string, unknown>;
        };
        security?: Array<Record<string, unknown>>;
      }>>;
    };
    const operation = document.paths?.['/api/v1/profile/avatar']?.post;

    expect(operation).toBeDefined();
    expect(operation?.requestBody?.content?.['multipart/form-data']).toBeDefined();
    expect(operation?.security).toEqual([{ betterAuthSession: [] }]);
  });

  it('stores the uploaded object as a file reference', async () => {
    authenticateStudent();
    const storedAvatar = {
      bucket: 'kuquest',
      objectKey: `avatars/${studentId}/avatar.png`,
      contentType: 'image/png' as const,
      sizeBytes: 12,
    };
    spyOn(avatarStorage, 'upload').mockResolvedValue(storedAvatar);
    const transaction = spyOn(db, 'transaction').mockResolvedValue({ fileId });

    const response = await app.handle(
      avatarRequest(
        new File(['image-content'], 'avatar.png', { type: 'image/png' }),
      ),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      success: true,
      data: { fileId },
    });
    expect(avatarStorage.upload).toHaveBeenCalledWith(
      studentId,
      expect.any(File),
    );
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(body)).not.toContain('s3-api.kubits.org');
  });

  it('rejects an avatar larger than 5 MB', async () => {
    authenticateStudent();
    const avatar = new File(
      [new Uint8Array(5 * 1024 * 1024 + 1)],
      'avatar.png',
      { type: 'image/png' },
    );

    const response = await app.handle(avatarRequest(avatar));
    const body = await response.json();

    expect(response.status).toBe(413);
    expect(body).toEqual({
      success: false,
      error: {
        code: 'AVATAR_TOO_LARGE',
        message: 'Avatar must be 5 MB or smaller',
      },
    });
  });

  it('rejects content that is not a supported image', async () => {
    authenticateStudent();

    const response = await app.handle(
      avatarRequest(
        new File(['not-an-image'], 'avatar.png', { type: 'image/png' }),
      ),
    );
    const body = await response.json();

    expect(response.status).toBe(415);
    expect(body).toEqual({
      success: false,
      error: {
        code: 'UNSUPPORTED_AVATAR_TYPE',
        message: 'Avatar must be a JPEG, PNG, or WebP image',
      },
    });
  });

  it('returns a safe error when object storage rejects the upload', async () => {
    authenticateStudent();
    spyOn(avatarStorage, 'upload').mockRejectedValue(
      new AvatarUploadError('secret RustFS detail'),
    );

    const response = await app.handle(
      avatarRequest(
        new File(['image-content'], 'avatar.png', { type: 'image/png' }),
      ),
    );
    const body = await response.json();

    expect(response.status).toBe(502);
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
