import { authUser } from '@/database/schema/auth.schema';
import { file } from '@/database/schema/file.schema';

import { describe, expect, it } from 'bun:test';
import { getTableColumns } from 'drizzle-orm';

describe('file reference database schema', () => {
  it('stores an avatar as metadata and an auth_user file pointer', () => {
    const fileColumns = getTableColumns(file);
    const studentColumns = getTableColumns(authUser);

    expect(studentColumns.imageFileId.name).toBe('image_file_id');
    expect(fileColumns.id.name).toBe('id');
    expect(fileColumns.bucket.name).toBe('bucket');
    expect(fileColumns.objectKey.name).toBe('object_key');
    expect(fileColumns.contentType.name).toBe('content_type');
    expect(fileColumns.sizeBytes.name).toBe('size_bytes');
    expect(fileColumns.uploadedByUserId.name).toBe('uploaded_by_user_id');
    expect(fileColumns.deletedAt.name).toBe('deleted_at');
    expect(fileColumns).not.toHaveProperty('url');
  });
});
