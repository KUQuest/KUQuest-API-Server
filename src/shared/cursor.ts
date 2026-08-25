export const DEFAULT_PAGE_LIMIT = 20;
export const MAX_PAGE_LIMIT = 50;

export type CursorPayload = {
  v: 1;
  startTime: string;
  id: string;
};

export class CursorInputError extends Error {
  readonly code: 'INVALID_CURSOR' | 'INVALID_LIMIT';

  constructor(code: 'INVALID_CURSOR' | 'INVALID_LIMIT', message: string) {
    super(message);
    this.name = 'CursorInputError';
    this.code = code;
  }
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const parsePageLimit = (value: unknown): number => {
  if (value === undefined) return DEFAULT_PAGE_LIMIT;

  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > MAX_PAGE_LIMIT
  ) {
    throw new CursorInputError(
      'INVALID_LIMIT',
      `limit must be an integer between 1 and ${MAX_PAGE_LIMIT}`,
    );
  }

  return value;
};

const toBase64Url = (value: string): string =>
  btoa(value).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');

const fromBase64Url = (value: string): string => {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('invalid base64url');

  const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (value.length % 4)) % 4);
  return atob(padded);
};

export const encodeCursor = (payload: Omit<CursorPayload, 'v'>): string => {
  const startTime = new Date(payload.startTime);
  if (Number.isNaN(startTime.getTime()) || !uuidPattern.test(payload.id)) {
    throw new CursorInputError('INVALID_CURSOR', 'Cannot encode an invalid cursor');
  }

  return toBase64Url(
    JSON.stringify({ v: 1, startTime: startTime.toISOString(), id: payload.id }),
  );
};

export const decodeCursor = (value: unknown): CursorPayload | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0) {
    throw new CursorInputError('INVALID_CURSOR', 'cursor must be a non-empty string');
  }

  try {
    const parsed = JSON.parse(fromBase64Url(value)) as Partial<CursorPayload>;
    const startTime = typeof parsed.startTime === 'string' ? new Date(parsed.startTime) : null;

    if (
      parsed.v !== 1 ||
      !startTime ||
      Number.isNaN(startTime.getTime()) ||
      startTime.toISOString() !== parsed.startTime ||
      typeof parsed.id !== 'string' ||
      !uuidPattern.test(parsed.id)
    ) {
      throw new Error('invalid cursor payload');
    }

    return { v: 1, startTime: parsed.startTime, id: parsed.id };
  } catch {
    throw new CursorInputError('INVALID_CURSOR', 'cursor is invalid');
  }
};
