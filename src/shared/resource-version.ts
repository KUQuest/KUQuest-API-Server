export type ResourceVersion =
  | { value: number | undefined; invalid: false }
  | { value: undefined; invalid: true };

export const readResourceVersion = (request?: Request): ResourceVersion => {
  const raw = request?.headers.get('if-match') ?? request?.headers.get('x-resource-version');
  if (raw === null || raw === undefined) return { value: undefined, invalid: false };

  const value = raw.trim().replace(/^W\//, '').replace(/^"|"$/g, '');
  if (!/^[1-9]\d*$/.test(value)) return { value: undefined, invalid: true };

  const version = Number(value);
  return Number.isSafeInteger(version)
    ? { value: version, invalid: false }
    : { value: undefined, invalid: true };
};
