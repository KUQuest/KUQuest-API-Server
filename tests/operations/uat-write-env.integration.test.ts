import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const script = join(import.meta.dir, '../../scripts/uat-write-env.sh');

const composeAvailable = Bun.which('docker') !== null;

type ComposeConfig = { services: { api: { environment: Record<string, string> } } };

const awkward = [
  'p$ss=w#rd "double" \'single\' back\\slash',
  '  leading and trailing spaces  ',
  '$(id) ${HOME:-fallback} `backtick` $$ $',
  'literal \\n and \\t and \\\\ and \\" and \\$',
  '"starts and ends with quotes"',
  "'starts and ends with single quotes'",
  'unicode ✓ ünï = # ; & | < > ! % ^ * ~',
];

const baseEnvironment = (): Record<string, string> => ({
  DATABASE_URL: 'postgresql://kuquest_uat_app:pw@192.168.1.103:5432/kuquest',
  BETTER_AUTH_SECRET: awkward[0],
  ADMIN_BETTER_AUTH_SECRET: awkward[1],
  GOOGLE_CLIENT_SECRET: awkward[2],
  S3_ACCESS_KEY_ID: awkward[3],
  S3_SECRET_ACCESS_KEY: awkward[4],
  XENDIT_SECRET_KEY: awkward[5],
  XENDIT_WEBHOOK_TOKEN: awkward[6],
  PAYOUT_DESTINATION_ENCRYPTION_KEY: awkward[2] + awkward[0],
  PAYMENT_PROVIDER_EVENT_ENCRYPTION_KEY: awkward[3] + awkward[1],
  BETTER_AUTH_URL: 'https://uat.api.kubits.org',
  GOOGLE_CLIENT_ID: 'client-id.apps.googleusercontent.com',
  S3_ENDPOINT: 'https://s3-api.kubits.org',
  S3_REGION: 'us-east-1',
  S3_BUCKET: 'kuquest-uat',
  CMS_ORIGIN: 'https://cms.example.org',
  TERMS_URL: 'https://example.org/terms?a=1&b=$2',
  PRIVACY_URL: 'https://example.org/privacy',
  DATA_USAGE_URL: 'https://example.org/data',
  CONTACT_US_URL: 'https://example.org/contact',
});

const writeEnvironment = async (
  directory: string,
  env: Record<string, string>
): Promise<{ status: number; file: string }> => {
  const file = join(directory, '.env');
  const process = Bun.spawn(['bash', script, file], {
    env: { PATH: Bun.env.PATH ?? '', ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return { status: await process.exited, file };
};

const withDirectory = async (run: (directory: string) => Promise<void>) => {
  const directory = await mkdtemp(join(tmpdir(), 'kuquest-uat-env-'));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

// Compare booleans, not strings, so a failure never prints a secret value.
test.skipIf(!composeAvailable)(
  'Docker Compose hands the API the exact original value of every special-character secret',
  async () => {
    await withDirectory(async (directory) => {
      const env = {
        ...baseEnvironment(),
        ANDROID_APP_LINK_TARGETS: awkward[2],
        IOS_APP_LINK_APP_IDS: awkward[3],
      };
      expect((await writeEnvironment(directory, env)).status).toBe(0);

      await writeFile(
        join(directory, 'compose.yaml'),
        'services:\n  api:\n    image: scratch\n    env_file:\n      - .env\n'
      );
      const config = Bun.spawnSync(['docker', 'compose', 'config', '--format', 'json'], {
        cwd: directory,
        env: { PATH: Bun.env.PATH ?? '', HOME: Bun.env.HOME ?? '' },
      });
      expect(config.exitCode).toBe(0);

      const parsed: ComposeConfig = JSON.parse(config.stdout.toString());
      const received = parsed.services.api.environment;

      for (const [name, value] of Object.entries(env)) {
        // `docker compose config` doubles every `$` when it prints; undo that to get the real value.
        const actual = received[name]?.replaceAll('$$', '$');
        expect([name, actual === value]).toEqual([name, true]);
      }
      expect(received.NODE_ENV).toBe('production');
      expect(received.DEPLOYMENT_ENV).toBe('uat');
    });
  },
  15_000
);

test('UAT env file sets safe fixed values and never adds Staging test settings', async () => {
  await withDirectory(async (directory) => {
    const written = await writeEnvironment(directory, baseEnvironment());
    expect(written.status).toBe(0);

    const lines = (await readFile(written.file, 'utf8')).split('\n');
    expect(lines).toContain('DEPLOYMENT_ENV=uat');
    expect(lines).toContain('STAGING_TEST_AUTH_ENABLED=false');
    expect(lines).toContain('LOCAL_FINANCE_TEST_ENABLED=false');
    expect(lines).toContain('PAYOUT_DESTINATION_ENCRYPTION_KEY_VERSION="v1"');
    expect(lines.some((line) => line.startsWith('STAGING_TEST_AUTH_EMAIL'))).toBe(false);
    expect(lines.some((line) => line.startsWith('ADMIN_EMAIL'))).toBe(false);
    expect(lines.some((line) => line.startsWith('POSTGRES_'))).toBe(false);
  });
});

test('UAT env file is not written for line breaks, missing values, or the Staging bucket', async () => {
  const cases: Record<string, Record<string, string>> = {
    'line feed': { XENDIT_SECRET_KEY: 'a\nINJECTED=1' },
    'carriage return': { XENDIT_SECRET_KEY: 'a\rINJECTED=1' },
    'missing secret': { XENDIT_WEBHOOK_TOKEN: '' },
    'staging bucket': { S3_BUCKET: 'kuquest-uploads' },
  };

  for (const [label, override] of Object.entries(cases)) {
    await withDirectory(async (directory) => {
      const written = await writeEnvironment(directory, { ...baseEnvironment(), ...override });
      expect([label, written.status !== 0]).toEqual([label, true]);
      expect(await Bun.file(written.file).exists()).toBe(false);
    });
  }
});
