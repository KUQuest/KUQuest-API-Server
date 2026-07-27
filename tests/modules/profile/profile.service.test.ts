import { db } from '@/database/client';
import { replaceStudentAvatar } from '@/modules/profile/profile.service';

import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';

afterEach(() => {
  mock.restore();
});

describe('profile avatar persistence', () => {
  it('creates file metadata and updates only the Student file pointer', async () => {
    const insertValues = mock((_value: unknown) => ({
      returning: mock(async () => [
        { fileId: '018f47a7-1c7d-7c98-9a11-690d7e83430c' },
      ]),
    }));
    const updateValues = mock(() => ({
      where: mock(async () => undefined),
    }));
    const transaction = {
      select: mock(() => ({
        from: mock(() => ({
          where: mock(() => ({
            limit: mock(() => ({
              for: mock(async () => [
                { id: 'student-1', previousFileId: null },
              ]),
            })),
          })),
        })),
      })),
      insert: mock(() => ({ values: insertValues })),
      update: mock(() => ({ set: updateValues })),
    };
    spyOn(db, 'transaction').mockImplementation(
      (async (callback: (value: unknown) => Promise<unknown>) =>
        callback(transaction)) as never,
    );

    const result = await replaceStudentAvatar('student-1', {
      bucket: 'kuquest',
      objectKey: 'avatars/student-1/new.png',
      contentType: 'image/png',
      sizeBytes: 123,
    });

    expect(result).toEqual({
      fileId: '018f47a7-1c7d-7c98-9a11-690d7e83430c',
      previousFileId: null,
    });
    expect(insertValues).toHaveBeenCalledWith({
      bucket: 'kuquest',
      objectKey: 'avatars/student-1/new.png',
      contentType: 'image/png',
      sizeBytes: 123,
      uploadedByUserId: 'student-1',
    });
    expect(updateValues).toHaveBeenCalledWith({
      imageFileId: '018f47a7-1c7d-7c98-9a11-690d7e83430c',
    });
  });
});
