import { expect, test } from 'bun:test';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const stagingOperationsScript = join(
  import.meta.dir,
  '../../scripts/staging-operations.sh',
);

const createFixture = async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kuquest-staging-ops-'));
  const binaryDirectory = join(directory, 'bin');
  const backupDirectory = join(directory, 'backups');
  const dockerLog = join(directory, 'docker.log');

  await mkdir(binaryDirectory);
  await mkdir(backupDirectory);
  await writeFile(
    join(directory, '.env'),
    'DATABASE_URL=postgresql://kuquest:secret@database:5432/kuquest\n',
  );
  await writeFile(
    join(binaryDirectory, 'docker'),
    `#!/usr/bin/env bash
set -euo pipefail

printf '%s\\n' "$*" >> "$DOCKER_LOG"

if [[ "$*" == "compose ps -q api" ]]; then
  if [[ "\${MOCK_NO_PREVIOUS:-}" != "1" ]]; then
    printf 'current-api-container\\n'
  fi
elif [[ "$1" == "inspect" ]]; then
  printf 'ghcr.io/kuquest/kuquest-api-server:previous\\n'
elif [[ "$1" == "run" && "$*" == *"pg_dump"* ]]; then
  for argument in "$@"; do
    if [[ "$argument" == /backups/* ]]; then
      if [[ "\${MOCK_EMPTY_BACKUP:-}" == "1" ]]; then
        : > "$MOCK_BACKUP_DIR/\${argument##*/}"
      else
        printf 'backup\\n' > "$MOCK_BACKUP_DIR/\${argument##*/}"
      fi
    fi
  done
  if [[ "\${MOCK_BACKUP_FAILURE:-}" == "1" ]]; then
    exit 1
  fi
elif [[ "$1" == "run" && "$*" == *"pg_restore"* ]]; then
  if [[ "\${MOCK_CORRUPT_BACKUP:-}" == "1" || "$*" == *"corrupt"* ]]; then
    exit 1
  fi
  exit 0
elif [[ "$1" == "run" && "$*" == *"to_regclass"* ]]; then
  printf 'ok\\n'
elif [[ "$*" == *"drizzle/meta/_journal.json"* ]]; then
  printf '1\\n'
elif [[ "$1" == "run" && "$*" == *"SELECT count(*) FROM drizzle.__drizzle_migrations"* ]]; then
  printf '1\\n'
fi

if [[ "$*" == compose\\ up* && "\${MOCK_ROLLOUT_FAILURE:-}" == "1" && "$APP_IMAGE" == *":new" ]]; then
  exit 1
fi

if [[ "$*" == compose\\ up* && "\${MOCK_RESTORE_FAILURE:-}" == "1" && "$APP_IMAGE" == *":previous" ]]; then
  exit 1
fi

if [[ "$*" == *"compose run --rm --no-deps api bun run db:migrate"* && "\${MOCK_MIGRATION_FAILURE:-}" == "1" ]]; then
  exit 1
fi
`,
  );
  await chmod(join(binaryDirectory, 'docker'), 0o755);

  return {
    backupDirectory,
    binaryDirectory,
    directory,
    dockerLog,
  };
};

type StagingFixture = Awaited<ReturnType<typeof createFixture>>;

const runStagingOperation = (
  fixture: StagingFixture,
  operation: 'bootstrap' | 'deploy',
  options: {
    env?: Record<string, string>;
    input?: string;
  } = {},
) =>
  Bun.spawnSync(['bash', stagingOperationsScript, operation], {
    cwd: fixture.directory,
    env: {
      ...process.env,
      APP_IMAGE: 'ghcr.io/kuquest/kuquest-api-server:new',
      BACKUP_DIR: fixture.backupDirectory,
      DOCKER_LOG: fixture.dockerLog,
      ENV_FILE: join(fixture.directory, '.env'),
      MOCK_BACKUP_DIR: fixture.backupDirectory,
      PATH: `${fixture.binaryDirectory}:${process.env.PATH}`,
      STAGING_DIR: fixture.directory,
      STAGING_NETWORK: 'kuquest-staging_default',
      ...options.env,
    },
    stdin: options.input
      ? new TextEncoder().encode(options.input)
      : undefined,
    stderr: 'pipe',
    stdout: 'pipe',
  });

test('staging deploy backs up and migrates before replacing the API', async () => {
  const fixture = await createFixture();

  try {
    const result = runStagingOperation(fixture, 'deploy');
    const commands = (await readFile(fixture.dockerLog, 'utf8')).split('\n');

    const pull = commands.findIndex((line) => line === 'compose pull api');
    const backup = commands.findIndex((line) => line.includes('pg_dump'));
    const verifyBackup = commands.findIndex((line) =>
      line.includes('pg_restore'),
    );
    const migrate = commands.findIndex((line) =>
      line.includes('compose run --rm --no-deps api bun run db:migrate'),
    );
    const rollout = commands.findIndex((line) =>
      line.includes(
        'compose up -d --no-deps --remove-orphans --wait --wait-timeout 60 api',
      ),
    );

    expect(result.exitCode).toBe(0);
    expect(pull).toBeGreaterThan(-1);
    expect(backup).toBeGreaterThan(pull);
    expect(verifyBackup).toBeGreaterThan(backup);
    expect(migrate).toBeGreaterThan(verifyBackup);
    expect(rollout).toBeGreaterThan(migrate);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('staging deploy retains only the two newest valid backups', async () => {
  const fixture = await createFixture();

  try {
    await Promise.all(
      [
        'kuquest-20260101T000000Z.dump',
        'kuquest-20260201T000000Z.dump',
        'kuquest-20260301T000000Z.dump',
      ].map((name) =>
        writeFile(join(fixture.backupDirectory, name), 'valid backup\n'),
      ),
    );

    const result = runStagingOperation(fixture, 'deploy');
    const backups = (await readdir(fixture.backupDirectory)).filter((name) =>
      name.endsWith('.dump'),
    );

    expect(result.exitCode).toBe(0);
    expect(backups).toHaveLength(2);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('staging deploy discards corrupt backups before retention', async () => {
  const fixture = await createFixture();

  try {
    const corruptBackup = 'kuquest-99991231T000000Z-corrupt.dump';
    const validBackup = 'kuquest-20260301T000000Z.dump';
    await Promise.all([
      writeFile(
        join(fixture.backupDirectory, corruptBackup),
        'corrupt backup\n',
      ),
      writeFile(join(fixture.backupDirectory, validBackup), 'valid backup\n'),
    ]);

    const result = runStagingOperation(fixture, 'deploy');
    const backups = await readdir(fixture.backupDirectory);

    expect(result.exitCode).toBe(0);
    expect(backups).not.toContain(corruptBackup);
    expect(backups).toContain(validBackup);
    expect(backups).toHaveLength(2);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('staging deploy restores the previous image after failed readiness', async () => {
  const fixture = await createFixture();

  try {
    const result = runStagingOperation(fixture, 'deploy', {
      env: { MOCK_ROLLOUT_FAILURE: '1' },
    });
    const output = `${result.stdout.toString()}${result.stderr.toString()}`;
    const commands = await readFile(fixture.dockerLog, 'utf8');
    const rolloutAttempts = commands
      .split('\n')
      .filter((line) => line.startsWith('compose up '));

    expect(result.exitCode).toBe(1);
    expect(rolloutAttempts).toHaveLength(2);
    expect(output).toContain(
      'Previous API image restored: ghcr.io/kuquest/kuquest-api-server:previous',
    );
    expect(commands).not.toContain('down');
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('migration failure leaves the current API running', async () => {
  const fixture = await createFixture();

  try {
    const result = runStagingOperation(fixture, 'deploy', {
      env: { MOCK_MIGRATION_FAILURE: '1' },
    });
    const output = `${result.stdout.toString()}${result.stderr.toString()}`;
    const commands = await readFile(fixture.dockerLog, 'utf8');

    expect(result.exitCode).toBe(1);
    expect(output).toContain(
      'Deployment stopped during migration; current API was not replaced',
    );
    expect(commands).not.toContain('compose up');
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('backup failure stops before migration or API replacement', async () => {
  const fixture = await createFixture();

  try {
    const result = runStagingOperation(fixture, 'deploy', {
      env: { MOCK_BACKUP_FAILURE: '1' },
    });
    const output = `${result.stdout.toString()}${result.stderr.toString()}`;
    const commands = await readFile(fixture.dockerLog, 'utf8');
    const backups = await readdir(fixture.backupDirectory);

    expect(result.exitCode).toBe(1);
    expect(output).toContain(
      'Deployment stopped during backup; current API was not replaced',
    );
    expect(commands).not.toContain('db:migrate');
    expect(commands).not.toContain('compose up');
    expect(backups).toHaveLength(0);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('empty backup output blocks deployment and is discarded', async () => {
  const fixture = await createFixture();

  try {
    const result = runStagingOperation(fixture, 'deploy', {
      env: { MOCK_EMPTY_BACKUP: '1' },
    });
    const commands = await readFile(fixture.dockerLog, 'utf8');
    const backups = await readdir(fixture.backupDirectory);

    expect(result.exitCode).toBe(1);
    expect(commands).not.toContain('db:migrate');
    expect(backups).toHaveLength(0);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('corrupt backup output blocks deployment and is discarded', async () => {
  const fixture = await createFixture();

  try {
    const result = runStagingOperation(fixture, 'deploy', {
      env: { MOCK_CORRUPT_BACKUP: '1' },
    });
    const commands = await readFile(fixture.dockerLog, 'utf8');
    const backups = await readdir(fixture.backupDirectory);

    expect(result.exitCode).toBe(1);
    expect(commands).not.toContain('db:migrate');
    expect(backups).toHaveLength(0);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('failed readiness without a previous image remains failed', async () => {
  const fixture = await createFixture();

  try {
    const result = runStagingOperation(fixture, 'deploy', {
      env: {
        MOCK_NO_PREVIOUS: '1',
        MOCK_ROLLOUT_FAILURE: '1',
      },
    });
    const output = `${result.stdout.toString()}${result.stderr.toString()}`;
    const commands = await readFile(fixture.dockerLog, 'utf8');
    const rolloutAttempts = commands
      .split('\n')
      .filter((line) => line.startsWith('compose up '));

    expect(result.exitCode).toBe(1);
    expect(rolloutAttempts).toHaveLength(1);
    expect(output).toContain('no previous API image is available');
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('failed restoration reports both rollout and rollback failures', async () => {
  const fixture = await createFixture();

  try {
    const result = runStagingOperation(fixture, 'deploy', {
      env: {
        MOCK_RESTORE_FAILURE: '1',
        MOCK_ROLLOUT_FAILURE: '1',
      },
    });
    const output = `${result.stdout.toString()}${result.stderr.toString()}`;

    expect(result.exitCode).toBe(1);
    expect(output).toContain('New API image failed readiness');
    expect(output).toContain('rollback also failed');
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('bootstrap backs up, resets only public, migrates, and verifies', async () => {
  const fixture = await createFixture();

  try {
    const result = runStagingOperation(fixture, 'bootstrap', {
      input: 'RESET staging public schema\n',
    });
    const commands = (await readFile(fixture.dockerLog, 'utf8')).split('\n');
    const backup = commands.findIndex((line) => line.includes('pg_dump'));
    const reset = commands.findIndex((line) =>
      line.includes('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'),
    );
    const migrate = commands.findIndex((line) =>
      line.includes('compose run --rm --no-deps api bun run db:migrate'),
    );
    const verify = commands.findIndex((line) =>
      line.includes("to_regclass('drizzle.__drizzle_migrations')"),
    );
    const expectedJournalCount = commands.findIndex((line) =>
      line.includes('drizzle/meta/_journal.json'),
    );
    const appliedJournalCount = commands.findIndex((line) =>
      line.includes('SELECT count(*) FROM drizzle.__drizzle_migrations'),
    );

    expect(result.exitCode).toBe(0);
    expect(reset).toBeGreaterThan(backup);
    expect(migrate).toBeGreaterThan(reset);
    expect(verify).toBeGreaterThan(migrate);
    expect(expectedJournalCount).toBeGreaterThan(migrate);
    expect(appliedJournalCount).toBeGreaterThan(expectedJournalCount);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('bootstrap requires the exact destructive confirmation', async () => {
  const fixture = await createFixture();

  try {
    const result = runStagingOperation(fixture, 'bootstrap', {
      input: 'yes\n',
    });
    const commands = await readFile(fixture.dockerLog, 'utf8');

    expect(result.exitCode).toBe(1);
    expect(commands).toContain('pg_dump');
    expect(commands).not.toContain('DROP SCHEMA');
    expect(commands).not.toContain('db:migrate');
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('bootstrap reports its recovery backup when migration fails', async () => {
  const fixture = await createFixture();

  try {
    const result = runStagingOperation(fixture, 'bootstrap', {
      env: { MOCK_MIGRATION_FAILURE: '1' },
      input: 'RESET staging public schema\n',
    });
    const output = `${result.stdout.toString()}${result.stderr.toString()}`;
    const commands = await readFile(fixture.dockerLog, 'utf8');

    expect(result.exitCode).toBe(1);
    expect(output).toContain('Bootstrap failed; restore from');
    expect(output).toContain(fixture.backupDirectory);
    expect(commands).not.toContain('to_regclass');
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});
