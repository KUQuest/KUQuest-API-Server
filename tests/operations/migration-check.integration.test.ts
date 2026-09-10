import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const migrationCheckScript = join(
  import.meta.dir,
  '../../scripts/check-migrations.ts',
);

const run = (
  command: string[],
  cwd: string,
  env: Record<string, string> = {},
) =>
  Bun.spawnSync(command, {
    cwd,
    env: { ...process.env, ...env },
    stderr: 'pipe',
    stdout: 'pipe',
  });

const initializeFixture = async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kuquest-migration-check-'));

  await mkdir(join(directory, 'drizzle/meta'), { recursive: true });
  await writeFile(
    join(directory, 'package.json'),
    JSON.stringify({
      private: true,
      scripts: {
        'db:generate': 'bun fixture-generate.ts',
      },
    }),
  );
  await writeFile(join(directory, 'fixture-generate.ts'), '');
  await writeFile(join(directory, 'drizzle/0000_initial.sql'), 'SELECT 1;\n');
  await writeFile(join(directory, 'drizzle/0001_second.sql'), 'SELECT 2;\n');
  await writeFile(
    join(directory, 'drizzle/meta/_journal.json'),
    JSON.stringify({
      entries: [
        { idx: 0, tag: '0000_initial' },
        { idx: 1, tag: '0001_second' },
      ],
    }),
  );

  run(['git', 'init', '--quiet'], directory);
  run(['git', 'config', 'user.email', 'test@example.com'], directory);
  run(['git', 'config', 'user.name', 'Migration Test'], directory);
  run(['git', 'add', '.'], directory);
  run(['git', 'commit', '--quiet', '-m', 'initial migration'], directory);

  const base = run(['git', 'rev-parse', 'HEAD'], directory)
    .stdout.toString()
    .trim();

  return { base, directory };
};

test('migration check accepts a new forward migration', async () => {
  const fixture = await initializeFixture();

  try {
    await writeFile(
      join(fixture.directory, 'drizzle/0002_forward.sql'),
      'SELECT 3;\n',
    );

    const result = run(
      ['bun', migrationCheckScript, '--base', fixture.base],
      fixture.directory,
    );

    expect(result.exitCode).toBe(0);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('migration check rejects artifacts produced by schema drift', async () => {
  const fixture = await initializeFixture();

  try {
    await writeFile(
      join(fixture.directory, 'fixture-generate.ts'),
      [
        "import { writeFile } from 'node:fs/promises';",
        "await writeFile('drizzle/0002_generated.sql', 'SELECT 3;\\n');",
      ].join('\n'),
    );

    const result = run(
      ['bun', migrationCheckScript, '--base', fixture.base],
      fixture.directory,
    );
    const output = `${result.stdout.toString()}${result.stderr.toString()}`;

    expect(result.exitCode).toBe(1);
    expect(output).toContain('Migration artifacts are out of date');
    expect(output).toContain('bun run db:generate');
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('migration check detects generated changes to an already modified artifact', async () => {
  const fixture = await initializeFixture();

  try {
    await writeFile(
      join(fixture.directory, 'drizzle/meta/_journal.json'),
      JSON.stringify({
        entries: [
          { idx: 0, tag: '0000_initial' },
          { idx: 1, tag: '0001_second' },
          { idx: 2, tag: '0002_forward' },
        ],
      }),
    );
    await writeFile(
      join(fixture.directory, 'fixture-generate.ts'),
      [
        "import { readFile, writeFile } from 'node:fs/promises';",
        "const path = 'drizzle/meta/_journal.json';",
        'const journal = JSON.parse(await readFile(path, "utf8"));',
        "journal.entries.push({ idx: 3, tag: '0003_generated' });",
        'await writeFile(path, JSON.stringify(journal));',
      ].join('\n'),
    );

    const result = run(
      ['bun', migrationCheckScript, '--base', fixture.base],
      fixture.directory,
    );
    const output = `${result.stdout.toString()}${result.stderr.toString()}`;

    expect(result.exitCode).toBe(1);
    expect(output).toContain('Migration artifacts are out of date');
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('migration check rejects changes to inherited migration SQL', async () => {
  const fixture = await initializeFixture();

  try {
    await writeFile(
      join(fixture.directory, 'drizzle/0000_initial.sql'),
      'SELECT 999;\n',
    );

    const result = run(
      ['bun', migrationCheckScript, '--base', fixture.base],
      fixture.directory,
    );
    const output = `${result.stdout.toString()}${result.stderr.toString()}`;

    expect(result.exitCode).toBe(1);
    expect(output).toContain('Inherited migration SQL is immutable');
    expect(output).toContain('drizzle/0000_initial.sql');
    expect(output).toContain('new forward migration');
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('migration check accepts an exact approved migration repair', async () => {
  const fixture = await initializeFixture();

  try {
    const migrationPath = 'drizzle/0000_initial.sql';
    await writeFile(join(fixture.directory, migrationPath), 'SELECT 999;\n');
    await mkdir(join(fixture.directory, 'docs/agents'), { recursive: true });

    const baseBlob = run(
      ['git', 'rev-parse', `${fixture.base}:${migrationPath}`],
      fixture.directory,
    ).stdout.toString().trim();
    const repairedBlob = run(
      ['git', 'hash-object', '--', migrationPath],
      fixture.directory,
    ).stdout.toString().trim();

    await writeFile(
      join(fixture.directory, 'docs/agents/migration-repairs.json'),
      JSON.stringify({
        repairs: [
          {
            baseBlob,
            path: migrationPath,
            reason: 'The inherited migration requires a reviewed repair.',
            repairedBlob,
          },
        ],
      }),
    );

    const result = run(
      ['bun', migrationCheckScript, '--base', fixture.base],
      fixture.directory,
    );

    expect(result.exitCode).toBe(0);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('migration check rejects a migration repair with a hash mismatch', async () => {
  const fixture = await initializeFixture();

  try {
    const migrationPath = 'drizzle/0000_initial.sql';
    await writeFile(join(fixture.directory, migrationPath), 'SELECT 999;\n');
    await mkdir(join(fixture.directory, 'docs/agents'), { recursive: true });

    const baseBlob = run(
      ['git', 'rev-parse', `${fixture.base}:${migrationPath}`],
      fixture.directory,
    ).stdout.toString().trim();
    await writeFile(
      join(fixture.directory, 'docs/agents/migration-repairs.json'),
      JSON.stringify({
        repairs: [
          {
            baseBlob,
            path: migrationPath,
            reason: 'The inherited migration requires a reviewed repair.',
            repairedBlob: 'not-the-current-blob',
          },
        ],
      }),
    );

    const result = run(
      ['bun', migrationCheckScript, '--base', fixture.base],
      fixture.directory,
    );
    const output = `${result.stdout.toString()}${result.stderr.toString()}`;

    expect(result.exitCode).toBe(1);
    expect(output).toContain('Inherited migration SQL is immutable');
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('migration check rejects an invalid migration repair manifest', async () => {
  const fixture = await initializeFixture();

  try {
    await mkdir(join(fixture.directory, 'docs/agents'), { recursive: true });
    await writeFile(
      join(fixture.directory, 'docs/agents/migration-repairs.json'),
      JSON.stringify({ repairs: [{ path: 'drizzle/0000_initial.sql' }] }),
    );

    const result = run(
      ['bun', migrationCheckScript, '--base', fixture.base],
      fixture.directory,
    );
    const output = `${result.stdout.toString()}${result.stderr.toString()}`;

    expect(result.exitCode).toBe(1);
    expect(output).toContain('Migration repair manifest has an invalid shape');
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('migration check rejects reordering inherited migration history', async () => {
  const fixture = await initializeFixture();

  try {
    await writeFile(
      join(fixture.directory, 'drizzle/meta/_journal.json'),
      JSON.stringify({
        entries: [
          { idx: 1, tag: '0001_second' },
          { idx: 0, tag: '0000_initial' },
        ],
      }),
    );

    const result = run(
      ['bun', migrationCheckScript, '--base', fixture.base],
      fixture.directory,
    );
    const output = `${result.stdout.toString()}${result.stderr.toString()}`;

    expect(result.exitCode).toBe(1);
    expect(output).toContain('Inherited migration journal entries are immutable');
    expect(output).toContain('new forward migration');
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});
