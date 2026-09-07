import {
  AdminActionError,
  normalizeReasonCatalog,
  normalizeReasonCode,
  normalizeSafeObject,
} from '@/modules/admin';

import { describe, expect, it } from 'bun:test';

describe('Admin Action policy', () => {
  it('normalizes and freezes a versioned action-specific reason catalog', () => {
    const catalog = normalizeReasonCatalog({
      version: 1,
      actions: {
        MEMBER_FREEZE: {
          kind: 'COMMAND',
          requiresReason: true,
          allowedReasonCodes: ['POLICY_REVIEW'],
        },
      },
    });

    expect(catalog.version).toBe(1);
    expect(catalog.actions.MEMBER_FREEZE?.allowedReasonCodes).toEqual(['POLICY_REVIEW']);
    expect(Object.isFrozen(catalog)).toBe(true);
    expect(Object.isFrozen(catalog.actions)).toBe(true);
    expect(Object.isFrozen(catalog.actions.MEMBER_FREEZE?.allowedReasonCodes)).toBe(true);
  });

  it('rejects an unversioned or unusable reason catalog', () => {
    expect(() => normalizeReasonCatalog(null)).toThrowError(AdminActionError);
    expect(() => normalizeReasonCatalog({
      version: 0,
      actions: {
        MEMBER_FREEZE: {
          kind: 'COMMAND',
          requiresReason: true,
          allowedReasonCodes: ['POLICY_REVIEW'],
        },
      },
    })).toThrowError(AdminActionError);
    expect(() => normalizeReasonCatalog({
      version: 1,
      actions: {
        MEMBER_FREEZE: {
          kind: 'COMMAND',
          requiresReason: true,
          allowedReasonCodes: [],
        },
      },
    })).toThrowError(AdminActionError);
  });

  it('requires controlled reason codes and rejects free-form values', () => {
    const rule = {
      kind: 'COMMAND' as const,
      requiresReason: true,
      allowedReasonCodes: ['POLICY_REVIEW'],
    };

    expect(normalizeReasonCode(rule, ' POLICY_REVIEW ')).toBe('POLICY_REVIEW');
    expect(() => normalizeReasonCode(rule, undefined)).toThrowError(AdminActionError);
    expect(() => normalizeReasonCode(rule, 'free form reason')).toThrowError(AdminActionError);
  });

  it('accepts safe structured metadata and rejects sensitive fields or links', () => {
    expect(normalizeSafeObject({
      previousStatus: 'ACTIVE',
      nextStatus: 'FROZEN',
      status: 'ASSIGNED',
      sequence: 2,
      flags: [true, null],
    })).toEqual({
      previousStatus: 'ACTIVE',
      nextStatus: 'FROZEN',
      status: 'ASSIGNED',
      sequence: 2,
      flags: [true, null],
    });
    expect(() => normalizeSafeObject({ text: 'private message' })).toThrowError(AdminActionError);
    expect(() => normalizeSafeObject({ credentials: 'private' })).toThrowError(AdminActionError);
    expect(() => normalizeSafeObject({ messageText: 'private' })).toThrowError(AdminActionError);
    expect(() => normalizeSafeObject({ reason: 'free form reason' })).toThrowError(AdminActionError);
    expect(() => normalizeSafeObject({ downloadLink: 'https://example.com/signed' })).toThrowError(AdminActionError);
  });
});
