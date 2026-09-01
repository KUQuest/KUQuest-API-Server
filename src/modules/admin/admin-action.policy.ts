export type AdminActionJsonValue =
  | string
  | number
  | boolean
  | null
  | AdminActionJsonValue[]
  | { [key: string]: AdminActionJsonValue };

export type AdminActionSafeValue =
  | string
  | number
  | boolean
  | null
  | AdminActionSafeValue[]
  | { [key: string]: AdminActionSafeValue };

export type AdminActionSafeObject = { [key: string]: AdminActionSafeValue };

export type AdminActionKind = 'COMMAND' | 'EVIDENCE_ACCESS';

export type AdminActionReasonRule = {
  kind: AdminActionKind;
  requiresReason: boolean;
  allowedReasonCodes: readonly string[];
};

export type AdminActionReasonCatalog = {
  version: number;
  actions: Readonly<Record<string, AdminActionReasonRule>>;
};

export type AdminActionErrorCode =
  | 'ADMIN_ACTION_INVALID_CATALOG'
  | 'ADMIN_ACTION_ACTION_NOT_CATALOGED'
  | 'ADMIN_ACTION_ACTION_KIND_INVALID'
  | 'ADMIN_ACTION_REASON_REQUIRED'
  | 'ADMIN_ACTION_INVALID_REASON_CODE'
  | 'ADMIN_ACTION_INVALID_REQUEST_KEY'
  | 'ADMIN_ACTION_INVALID_VERSION'
  | 'ADMIN_ACTION_INVALID_RESOURCE'
  | 'ADMIN_ACTION_INVALID_REQUEST'
  | 'ADMIN_ACTION_UNSAFE_METADATA'
  | 'ADMIN_ACTION_INVALID_RESULT'
  | 'ADMIN_ACTION_ADMIN_NOT_FOUND'
  | 'ADMIN_ACTION_KEY_REUSED'
  | 'ADMIN_ACTION_CONFLICT'
  | 'ADMIN_ACTION_WRITE_FAILED';

export class AdminActionError extends Error {
  readonly code: AdminActionErrorCode;

  constructor(code: AdminActionErrorCode, message: string) {
    super(message);
    this.name = 'AdminActionError';
    this.code = code;
  }
}

const identifierPattern = /^[A-Za-z][A-Za-z0-9_.-]{0,99}$/;
const reasonCodePattern = /^[A-Z][A-Z0-9_.-]{0,99}$/;
const safeMetadataKeyPattern = /^[a-z][A-Za-z0-9_]{0,63}$/;
const unsafeMetadataKeyTokens: Record<string, true> = {
  attachment: true,
  body: true,
  comment: true,
  content: true,
  credential: true,
  credentials: true,
  description: true,
  detail: true,
  evidence: true,
  file: true,
  link: true,
  message: true,
  password: true,
  payload: true,
  raw: true,
  reason: true,
  secret: true,
  signature: true,
  session: true,
  signed: true,
  token: true,
  text: true,
  url: true,
};
const unsafeMetadataValuePattern = /(?:https?:\/\/|data:|s3:\/\/|x-amz-|signature=|\bsigned\b)/i;
const maximumSafeStringLength = 512;

const hasUnsafeMetadataKey = (key: string): boolean => {
  const normalized = key.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
  if (normalized.includes('reason_text')) return true;
  return normalized.split('_').some((token) => unsafeMetadataKeyTokens[token] === true);
};

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const invalidCatalog = (message: string): never => {
  throw new AdminActionError('ADMIN_ACTION_INVALID_CATALOG', message);
};

export const normalizeReasonCatalog = (
  catalog: unknown,
): AdminActionReasonCatalog => {
  if (!isPlainObject(catalog)) {
    invalidCatalog('Admin Action reason catalog must be an object.');
  }
  const catalogObject = catalog as Record<string, unknown>;

  const version = catalogObject.version;
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) {
    invalidCatalog('Admin Action reason catalog version must be a positive integer.');
  }
  const normalizedVersion = version as number;

  const rawActions = catalogObject.actions;
  if (!isPlainObject(rawActions) || Object.keys(rawActions).length === 0) {
    invalidCatalog('Admin Action reason catalog must contain actions.');
  }

  const actions: Record<string, AdminActionReasonRule> = {};
  for (const [action, rawRule] of Object.entries(rawActions as Record<string, unknown>)) {
    if (!identifierPattern.test(action)) {
      invalidCatalog(`Admin Action ${action || '<empty>'} is not a valid action identifier.`);
    }
    if (!isPlainObject(rawRule)) {
      invalidCatalog(`Admin Action ${action} has an invalid reason rule.`);
    }
    const rule = rawRule as Record<string, unknown>;
    const kind = rule.kind;
    if (kind !== 'COMMAND' && kind !== 'EVIDENCE_ACCESS') {
      invalidCatalog(`Admin Action ${action} has an invalid action kind.`);
    }
    const requiresReason = rule.requiresReason;
    if (typeof requiresReason !== 'boolean') {
      invalidCatalog(`Admin Action ${action} must declare whether a reason is required.`);
    }
    const normalizedRequiresReason = requiresReason as boolean;
    const rawReasonCodes = rule.allowedReasonCodes;
    if (!Array.isArray(rawReasonCodes)) {
      invalidCatalog(`Admin Action ${action} must declare allowed reason codes.`);
    }

    const allowedReasonCodes = [...(rawReasonCodes as unknown[])];
    if (new Set(allowedReasonCodes).size !== allowedReasonCodes.length) {
      invalidCatalog(`Admin Action ${action} contains duplicate reason codes.`);
    }
    for (const reasonCode of allowedReasonCodes) {
      if (typeof reasonCode !== 'string' || !reasonCodePattern.test(reasonCode)) {
        invalidCatalog(`Admin Action ${action} contains an invalid reason code.`);
      }
    }
    if (normalizedRequiresReason && allowedReasonCodes.length === 0) {
      invalidCatalog(`Admin Action ${action} requires a reason code but allows none.`);
    }

    actions[action] = Object.freeze({
      kind: kind as AdminActionKind,
      requiresReason: normalizedRequiresReason,
      allowedReasonCodes: Object.freeze(allowedReasonCodes as string[]),
    });
  }

  return Object.freeze({
    version: normalizedVersion,
    actions: Object.freeze(actions),
  });
};

export const actionRuleFor = (
  catalog: AdminActionReasonCatalog,
  action: string,
  kind: AdminActionKind,
): AdminActionReasonRule => {
  const rule = Object.prototype.hasOwnProperty.call(catalog.actions, action)
    ? catalog.actions[action]
    : undefined;
  if (!rule) {
    throw new AdminActionError(
      'ADMIN_ACTION_ACTION_NOT_CATALOGED',
      `Admin Action ${action} is not in the reason catalog.`,
    );
  }
  if (rule.kind !== kind) {
    throw new AdminActionError(
      'ADMIN_ACTION_ACTION_KIND_INVALID',
      `Admin Action ${action} is not valid for a ${kind.toLowerCase().replace('_', ' ')} operation.`,
    );
  }
  return rule;
};

export const normalizeReasonCode = (
  rule: AdminActionReasonRule,
  reasonCode: string | undefined,
): string | undefined => {
  const normalized = reasonCode?.trim() || undefined;
  if (rule.requiresReason && !normalized) {
    throw new AdminActionError(
      'ADMIN_ACTION_REASON_REQUIRED',
      'Admin Action reason code is required.',
    );
  }
  if (normalized && !rule.allowedReasonCodes.includes(normalized)) {
    throw new AdminActionError(
      'ADMIN_ACTION_INVALID_REASON_CODE',
      'Admin Action reason code is not allowed for this operation.',
    );
  }
  return normalized;
};

const unsafeMetadata = (path: string, message: string): never => {
  throw new AdminActionError(
    'ADMIN_ACTION_UNSAFE_METADATA',
    `Admin Action ${message} at ${path}.`,
  );
};

const normalizeSafeValue = (value: unknown, path: string): AdminActionSafeValue => {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) unsafeMetadata(path, 'metadata must use safe integer values');
    return value;
  }
  if (typeof value === 'string') {
    if (value.length > maximumSafeStringLength) {
      unsafeMetadata(path, 'metadata string is too long');
    }
    if (unsafeMetadataValuePattern.test(value)) {
      unsafeMetadata(path, 'metadata must not contain a URL or signed-link value');
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => normalizeSafeValue(item, `${path}[${index}]`));
  }
  if (!isPlainObject(value)) return unsafeMetadata(path, 'metadata must contain JSON values');

  const normalized: AdminActionSafeObject = {};
  for (const [key, child] of Object.entries(value)) {
    if (!safeMetadataKeyPattern.test(key) || hasUnsafeMetadataKey(key)) {
      unsafeMetadata(`${path}.${key}`, 'metadata contains a restricted field');
    }
    normalized[key] = normalizeSafeValue(child, `${path}.${key}`);
  }
  return normalized;
};

export const normalizeSafeObject = (
  value: unknown,
  field = 'metadata',
): AdminActionSafeObject => {
  if (value === undefined) return {};
  if (!isPlainObject(value)) unsafeMetadata(field, 'metadata must be an object');
  return normalizeSafeValue(value, field) as AdminActionSafeObject;
};

export const normalizeIdentifier = (
  value: string,
  field: string,
): string => {
  const normalized = value.trim();
  if (!normalized || normalized.length > 100 || !identifierPattern.test(normalized)) {
    throw new AdminActionError(
      'ADMIN_ACTION_INVALID_RESOURCE',
      `${field} must be a non-empty identifier of at most 100 characters.`,
    );
  }
  return normalized;
};

export const normalizeResourceId = (value: string, field = 'resourceId'): string => {
  const normalized = value.trim();
  if (!normalized || normalized.length > 255) {
    throw new AdminActionError(
      'ADMIN_ACTION_INVALID_RESOURCE',
      `${field} must be a non-empty resource identifier of at most 255 characters.`,
    );
  }
  return normalized;
};

export const normalizeRequestKey = (value: string): string => {
  const normalized = value.trim();
  if (!normalized || normalized.length > 200) {
    throw new AdminActionError(
      'ADMIN_ACTION_INVALID_REQUEST_KEY',
      'Admin Action request key must contain 1 to 200 non-whitespace characters.',
    );
  }
  return normalized;
};

export const assertPositiveVersion = (value: number, field: string): number => {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new AdminActionError(
      'ADMIN_ACTION_INVALID_VERSION',
      `${field} must be a positive integer.`,
    );
  }
  return value;
};

export const normalizeRequestValue = (
  value: unknown,
  path = 'request',
): AdminActionJsonValue | null => {
  if (value === undefined) return null;
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value)) {
      throw new AdminActionError('ADMIN_ACTION_INVALID_REQUEST', `${path} must contain safe JSON values.`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => normalizeRequestValue(item, `${path}[${index}]`));
  }
  if (!isPlainObject(value)) {
    throw new AdminActionError('ADMIN_ACTION_INVALID_REQUEST', `${path} must contain JSON values.`);
  }

  const normalized = Object.create(null) as { [key: string]: AdminActionJsonValue };
  for (const [key, child] of Object.entries(value)) {
    if (!key || key.length > 100) {
      throw new AdminActionError('ADMIN_ACTION_INVALID_REQUEST', `${path} contains an invalid field name.`);
    }
    normalized[key] = normalizeRequestValue(child, `${path}.${key}`);
  }
  return normalized;
};
