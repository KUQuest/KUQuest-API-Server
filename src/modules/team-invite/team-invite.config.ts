export interface AndroidAppLinkTarget {
  packageName: string;
  sha256CertFingerprints: string[];
}

export interface TeamInviteAssociationConfig {
  androidTargets: AndroidAppLinkTarget[] | null;
  appleAppIds: string[] | null;
}

const packageNamePattern = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;
const fingerprintPattern = /^(?:[A-Fa-f0-9]{2}:){31}[A-Fa-f0-9]{2}$/;
const appleAppIdPattern = /^[A-Z0-9]{10}\.[A-Za-z0-9.-]+$/;

export const parseAndroidAppLinkTargets = (
  value: string | undefined
): AndroidAppLinkTarget[] | null => {
  if (!value?.trim()) return null;

  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.length === 0) return null;

    const targets: AndroidAppLinkTarget[] = [];
    for (const candidate of parsed) {
      if (
        typeof candidate !== 'object' ||
        candidate === null ||
        !('packageName' in candidate) ||
        !('sha256CertFingerprints' in candidate)
      ) {
        return null;
      }

      const packageName = candidate.packageName;
      const fingerprints = candidate.sha256CertFingerprints;
      if (
        typeof packageName !== 'string' ||
        !packageNamePattern.test(packageName) ||
        !Array.isArray(fingerprints) ||
        fingerprints.length === 0 ||
        !fingerprints.every(
          (fingerprint) => typeof fingerprint === 'string' && fingerprintPattern.test(fingerprint)
        )
      ) {
        return null;
      }

      targets.push({
        packageName,
        sha256CertFingerprints: fingerprints.map((fingerprint: string) =>
          fingerprint.toUpperCase()
        ),
      });
    }

    return targets;
  } catch {
    return null;
  }
};

export const parseAppleAppLinkIds = (value: string | undefined): string[] | null => {
  if (!value?.trim()) return null;
  const appIds = value.split(',').map((appId) => appId.trim());
  return appIds.length > 0 && appIds.every((appId) => appleAppIdPattern.test(appId))
    ? [...new Set(appIds)]
    : null;
};
