export const readCookie = (
  headers: Headers,
  cookieName: string,
): string | null => {
  const source = headers.get('cookie');
  if (!source) return null;

  for (const field of source.split(';')) {
    const separator = field.indexOf('=');
    if (separator < 0) continue;
    const name = field.slice(0, separator).trim();
    if (name !== cookieName) continue;

    const value = field.slice(separator + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return null;
    }
  }
  return null;
};

export const actorCookie = (input: {
  name: string;
  value: string;
  maxAgeSeconds: number;
  secure: boolean;
}): string => {
  const attributes = [
    `${input.name}=${encodeURIComponent(input.value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.max(0, Math.floor(input.maxAgeSeconds))}`,
  ];
  if (input.secure) attributes.push('Secure');
  return attributes.join('; ');
};
