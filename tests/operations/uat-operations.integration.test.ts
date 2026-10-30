import { expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const script = join(import.meta.dir, '../../scripts/uat-operations.sh');
const appImage = `ghcr.io/kuquest/kuquest-api-server:${'a'.repeat(40)}`;
const validEnvironment = [
  'NODE_ENV=production',
  'DEPLOYMENT_ENV=uat',
  'STAGING_TEST_AUTH_ENABLED=false',
].join('\n');

type Result = { status: number; stderr: string; log: string[] };

const dockerMock = `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$DOCKER_LOG"
if [[ "$1" == inspect ]]; then printf 'ghcr.io/kuquest/kuquest-api-server:previous\\n'; fi
if [[ "$1" == run && "$*" == *pg_dump* ]]; then
  for argument in "$@"; do
    if [[ "$argument" == /backups/* ]]; then printf 'backup\\n' > "$UAT_DIR/backups/\${argument##*/}"; fi
  done
fi
if [[ "$*" == *process.env.DATABASE_URL* ]]; then
  printf '%s' "\${MOCK_DATABASE_URL:-postgresql://kuquest_uat_app:secret@192.168.1.103:5432/kuquest}"
fi
if [[ "$*" == *db:migrate* && "\${MOCK_MIGRATION_FAILURE:-}" == 1 ]]; then exit 1; fi
if [[ "$*" == "compose up"* && "\${MOCK_ROLLOUT_FAILURE:-}" == 1 && "\${APP_IMAGE:-}" != *previous ]]; then exit 1; fi
exit 0
`;

const runScript = async (
  operation: string,
  environment: string,
  env: Record<string, string> = {}
): Promise<Result> => {
  const directory = await mkdtemp(join(tmpdir(), 'kuquest-uat-ops-'));
  const dockerLog = join(directory, 'docker.log');
  try {
    await mkdir(join(directory, 'bin'));
    await mkdir(join(directory, 'backups'));
    await writeFile(join(directory, '.env'), environment);
    await writeFile(join(directory, 'bin/docker'), dockerMock);
    await chmod(join(directory, 'bin/docker'), 0o755);

    const process = Bun.spawn(['bash', script, operation], {
      env: {
        PATH: `${join(directory, 'bin')}:${Bun.env.PATH ?? ''}`,
        DOCKER_LOG: dockerLog,
        UAT_DIR: directory,
        APP_IMAGE: appImage,
        POSTGRES_CLIENT_IMAGE: 'ghcr.io/kuquest/kuquest-api-server:postgres-client-x',
        ...env,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const status = await process.exited;
    const log = await readFile(dockerLog, 'utf8').catch(() => '');
    return { status, stderr: await new Response(process.stderr).text(), log: log.split('\n') };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

const ran = (result: Result, step: string): boolean =>
  result.log.some((line) => line.includes(step));

test('UAT deploy backs up, migrates, then replaces the API, and never prunes images', async () => {
  const result = await runScript('deploy', validEnvironment);
  expect(result.status).toBe(0);

  const steps = [
    'compose pull',
    'pg_dump',
    'db:migrate',
    'db:verify-migration-journal',
    'compose up',
  ];
  const positions = steps.map((step) => result.log.findIndex((line) => line.includes(step)));
  expect(positions.every((position) => position >= 0)).toBe(true);
  expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  expect(ran(result, 'prune')).toBe(false);
});

test('UAT deploy stops before replacing the API when the migration fails', async () => {
  const result = await runScript('deploy', validEnvironment, { MOCK_MIGRATION_FAILURE: '1' });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('stopped during migration');
  expect(ran(result, 'compose up')).toBe(false);
});

test('UAT rollback swaps the image without running migrations', async () => {
  const result = await runScript('rollback', validEnvironment);
  expect(result.status).toBe(0);
  expect(ran(result, 'db:migrate')).toBe(false);
  expect(ran(result, 'compose up')).toBe(true);
});

test('UAT deploy restores the previous image when the new API is not ready', async () => {
  const result = await runScript('deploy', validEnvironment, { MOCK_ROLLOUT_FAILURE: '1' });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('Previous API image restored');
  expect(result.log.filter((line) => line.includes('compose up'))).toHaveLength(2);
});

test('UAT operations refuse a mutable tag', async () => {
  const result = await runScript('deploy', validEnvironment, {
    APP_IMAGE: 'ghcr.io/kuquest/kuquest-api-server:staging',
  });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('<40-character commit SHA>');
  expect(result.log.join('')).toBe('');
});

test('UAT operations refuse Staging settings', async () => {
  for (const broken of [
    validEnvironment.replace('DEPLOYMENT_ENV=uat', 'DEPLOYMENT_ENV=staging'),
    validEnvironment.replace('STAGING_TEST_AUTH_ENABLED=false', 'STAGING_TEST_AUTH_ENABLED=true'),
  ]) {
    const result = await runScript('deploy', broken);
    expect(result.status).not.toBe(0);
    expect(ran(result, 'db:migrate')).toBe(false);
  }
});

test('UAT operations refuse a DATABASE_URL outside the UAT database host before any backup', async () => {
  const result = await runScript('deploy', validEnvironment, {
    MOCK_DATABASE_URL: 'postgresql://kuquest_uat_app:secret@192.168.1.211:5432/kuquest',
  });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('must point to the UAT database host');
  expect(ran(result, 'pg_dump')).toBe(false);
  expect(ran(result, 'db:migrate')).toBe(false);
});
