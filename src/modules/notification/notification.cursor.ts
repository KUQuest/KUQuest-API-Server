import { CursorInputError } from '@/shared/cursor';

export type NotificationCursorPayload = {
  v: 1;
  createdAt: string;
  id: string;
};

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const toBase64Url = (value: string): string =>
  btoa(value).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');

const fromBase64Url = (value: string): string => {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new CursorInputError('INVALID_CURSOR', 'Invalid cursor format');
  }

  const padded =
    value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (value.length % 4)) % 4);
  return atob(padded);
};

export const encodeNotificationCursor = (payload: { createdAt: Date; id: string }): string => {
  if (!uuidPattern.test(payload.id)) {
    throw new CursorInputError('INVALID_CURSOR', 'Cannot encode an invalid notification cursor');
  }

  return toBase64Url(
    JSON.stringify({ v: 1, createdAt: payload.createdAt.toISOString(), id: payload.id })
  );
};

export const decodeNotificationCursor = (value: unknown): NotificationCursorPayload | undefined => {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') {
    throw new CursorInputError('INVALID_CURSOR', 'Cursor must be a string');
  }

  try {
    const raw = fromBase64Url(value);
    const parsed = JSON.parse(raw);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      parsed.v !== 1 ||
      typeof parsed.createdAt !== 'string' ||
      typeof parsed.id !== 'string' ||
      !uuidPattern.test(parsed.id)
    ) {
      throw new CursorInputError('INVALID_CURSOR', 'Invalid cursor format');
    }

    return parsed as NotificationCursorPayload;
  } catch (cause) {
    if (cause instanceof CursorInputError) throw cause;
    throw new CursorInputError('INVALID_CURSOR', 'Invalid cursor format');
  }
};
