import { describe, expect, it } from 'bun:test';

import {
  CursorInputError,
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  decodeCursor,
  encodeCursor,
  parsePageLimit,
} from '@/shared/cursor';

const id = '018f47a7-1c7d-7c98-9a11-690d7e83430c';
const startTime = '2026-08-26T00:00:00.000Z';

describe('Quest cursor', () => {
  it('round-trips the canonical sort key as opaque base64url text', () => {
    const cursor = encodeCursor({ id, startTime });

    expect(cursor).not.toContain('+');
    expect(cursor).not.toContain('/');
    expect(decodeCursor(cursor)).toEqual({ v: 1, id, startTime });
  });

  it('rejects malformed cursors', () => {
    expect(() => decodeCursor('not a cursor')).toThrow(CursorInputError);
    expect(() => decodeCursor('eyJ2IjoyfQ')).toThrow('cursor is invalid');
  });

  it('uses the approved page-limit range', () => {
    expect(parsePageLimit(undefined)).toBe(DEFAULT_PAGE_LIMIT);
    expect(parsePageLimit(MAX_PAGE_LIMIT)).toBe(MAX_PAGE_LIMIT);
    expect(() => parsePageLimit(0)).toThrow('between 1 and 50');
    expect(() => parsePageLimit(51)).toThrow('between 1 and 50');
  });
});
