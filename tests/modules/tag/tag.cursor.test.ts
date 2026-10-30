import { decodeTagCursor, encodeTagCursor } from '@/modules/tag/tag.cursor';
import { CursorInputError } from '@/shared/cursor';

import { describe, expect, it } from 'bun:test';

describe('Tag cursor', () => {
  const validId = '018f47a7-1c7d-7c98-9a11-690d7e83430c';
  const validName = 'Frontend Development';

  it('encodes and decodes a valid tag cursor round-trip', () => {
    const encoded = encodeTagCursor({ id: validId, name: validName });
    expect(typeof encoded).toBe('string');

    const decoded = decodeTagCursor(encoded);
    expect(decoded).toEqual({
      v: 1,
      id: validId,
      name: validName,
    });
  });

  it('returns undefined for empty, null, or undefined values', () => {
    expect(decodeTagCursor(undefined)).toBeUndefined();
    expect(decodeTagCursor(null)).toBeUndefined();
    expect(decodeTagCursor('')).toBeUndefined();
  });

  it('rejects a non-string cursor with INVALID_CURSOR', () => {
    expect(() => decodeTagCursor(12345)).toThrow(CursorInputError);
  });

  it('rejects malformed base64 with INVALID_CURSOR', () => {
    expect(() => decodeTagCursor('not-valid-base64!!')).toThrow(CursorInputError);
  });

  it('rejects invalid JSON payload with INVALID_CURSOR', () => {
    const invalidJson = btoa('not-json').replaceAll('=', '');
    expect(() => decodeTagCursor(invalidJson)).toThrow(CursorInputError);
  });

  it('rejects payloads with wrong version or missing fields', () => {
    const wrongVersion = btoa(JSON.stringify({ v: 2, id: validId, name: validName })).replaceAll(
      '=',
      ''
    );
    expect(() => decodeTagCursor(wrongVersion)).toThrow(CursorInputError);

    const missingId = btoa(JSON.stringify({ v: 1, name: validName })).replaceAll('=', '');
    expect(() => decodeTagCursor(missingId)).toThrow(CursorInputError);

    const invalidUuid = btoa(
      JSON.stringify({ v: 1, id: 'not-a-uuid', name: validName })
    ).replaceAll('=', '');
    expect(() => decodeTagCursor(invalidUuid)).toThrow(CursorInputError);
  });

  it('rejects encoding invalid payloads', () => {
    expect(() => encodeTagCursor({ id: 'not-uuid', name: validName })).toThrow(CursorInputError);
    expect(() => encodeTagCursor({ id: validId, name: '' })).toThrow(CursorInputError);
  });
});
