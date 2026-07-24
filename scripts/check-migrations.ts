import process from 'node:process';

const parseJournalEntries = (contents: string): unknown[] => {
  const journal: unknown = JSON.parse(contents);

  if (
    typeof journal !== 'object' ||
    journal === null ||
    !('entries' in journal) ||
    !Array.isArray(journal.entries)
  ) {
    throw new Error('Drizzle migration journal has no entries array.');
  }

  return journal.entries;
};

const gitOutput = (arguments_: string[]): string => {
  const result = Bun.spawnSync(['git', ...arguments_], {
    stderr: 'inherit',
    stdout: 'pipe',
  });

  if (result.exitCode !== 0) {
    throw new Error('Unable to inspect migration artifacts with git.');
  }

  return result.stdout.toString();
};

const migrationArtifactSnapshot = (): string => {
  const workingTreeDiff = gitOutput([
    'diff',
    '--binary',
    '--no-ext-diff',
    '--',
    'drizzle',
  ]);
  const stagedDiff = gitOutput([
    'diff',
    '--cached',
    '--binary',
    '--no-ext-diff',
    '--',
    'drizzle',
  ]);
  const untrackedPaths = gitOutput([
    'ls-files',
    '--others',
    '--exclude-standard',
    '-z',
    '--',
    'drizzle',
  ])
    .split('\0')
    .filter(Boolean);
  const untrackedHashes = untrackedPaths.map((path) => ({
    hash: gitOutput(['hash-object', '--', path]).trim(),
    path,
  }));

  return JSON.stringify({
    stagedDiff,
    untrackedHashes,
    workingTreeDiff,
  });
};

const baseArgumentIndex = process.argv.indexOf('--base');
const baseReference =
  (baseArgumentIndex >= 0 ? process.argv[baseArgumentIndex + 1] : undefined) ??
  process.env.MIGRATION_BASE_REF;

if (baseArgumentIndex >= 0 && !baseReference) {
  console.error('The `--base` option requires a git revision.');
  process.exit(1);
}

if (baseReference) {
  const inheritedFilesResult = Bun.spawnSync(
    [
      'git',
      'ls-tree',
      '-r',
      '--name-only',
      baseReference,
      '--',
      'drizzle',
    ],
    {
      stderr: 'pipe',
      stdout: 'pipe',
    },
  );

  if (inheritedFilesResult.exitCode !== 0) {
    console.error(
      `Unable to inspect migration history at base revision ${baseReference}.`,
    );
    console.error(inheritedFilesResult.stderr.toString().trim());
    process.exit(1);
  }

  const inheritedSqlFiles = inheritedFilesResult.stdout
    .toString()
    .split('\n')
    .filter((path) => path.endsWith('.sql'));
  const changedSqlFiles = inheritedSqlFiles.filter((path) => {
    const comparison = Bun.spawnSync(
      ['git', 'diff', '--quiet', baseReference, '--', path],
      {
        stderr: 'inherit',
        stdout: 'inherit',
      },
    );

    return comparison.exitCode !== 0;
  });

  if (changedSqlFiles.length > 0) {
    console.error('Inherited migration SQL is immutable:');
    for (const path of changedSqlFiles) {
      console.error(`- ${path}`);
    }
    console.error(
      'Restore the inherited SQL and represent the correction in a new forward migration.',
    );
    process.exit(1);
  }

  const inheritedJournalResult = Bun.spawnSync(
    ['git', 'show', `${baseReference}:drizzle/meta/_journal.json`],
    {
      stderr: 'pipe',
      stdout: 'pipe',
    },
  );

  if (inheritedJournalResult.exitCode === 0) {
    let inheritedEntries: unknown[];
    let currentEntries: unknown[];

    try {
      inheritedEntries = parseJournalEntries(
        inheritedJournalResult.stdout.toString(),
      );
      currentEntries = parseJournalEntries(
        await Bun.file('drizzle/meta/_journal.json').text(),
      );
    } catch {
      console.error('Unable to read the Drizzle migration journal.');
      process.exit(1);
    }

    const inheritedJournalChanged =
      currentEntries.length < inheritedEntries.length ||
      inheritedEntries.some(
        (entry, index) =>
          JSON.stringify(currentEntries[index]) !== JSON.stringify(entry),
      );

    if (inheritedJournalChanged) {
      console.error('Inherited migration journal entries are immutable.');
      console.error(
        'Restore the inherited journal order and create a new forward migration.',
      );
      process.exit(1);
    }
  }
}

const beforeGeneration = migrationArtifactSnapshot();
const generation = Bun.spawnSync(['bun', 'run', 'db:generate'], {
  stderr: 'inherit',
  stdout: 'inherit',
});

if (generation.exitCode !== 0) {
  process.exit(generation.exitCode);
}

const afterGeneration = migrationArtifactSnapshot();

if (beforeGeneration !== afterGeneration) {
  console.error(
    [
      'Migration artifacts are out of date.',
      'Run `bun run db:generate`, inspect the generated SQL, and commit the',
      'schema, SQL migration, and Drizzle metadata together.',
    ].join('\n'),
  );
  process.exit(1);
}
