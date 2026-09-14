import process from 'node:process';

const migrationRepairManifestPath = 'docs/agents/migration-repairs.json';

type MigrationRepair = {
  baseBlob: string;
  path: string;
  reason: string;
  repairedBlob: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isMigrationRepair = (value: unknown): value is MigrationRepair =>
  isRecord(value) &&
  typeof value.baseBlob === 'string' &&
  typeof value.path === 'string' &&
  typeof value.reason === 'string' &&
  typeof value.repairedBlob === 'string';

const readMigrationRepairs = async (): Promise<MigrationRepair[]> => {
  const file = Bun.file(migrationRepairManifestPath);
  if (!(await file.exists())) return [];

  let manifest: unknown;
  try {
    manifest = JSON.parse(await file.text());
  } catch {
    throw new Error('Migration repair manifest is not valid JSON.');
  }

  if (
    !isRecord(manifest) ||
    !Array.isArray(manifest.repairs) ||
    !manifest.repairs.every(isMigrationRepair)
  ) {
    throw new Error('Migration repair manifest has an invalid shape.');
  }

  return manifest.repairs;
};

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
  const workingTreeDiff = gitOutput(['diff', '--binary', '--no-ext-diff', '--', 'drizzle']);
  const stagedDiff = gitOutput(['diff', '--cached', '--binary', '--no-ext-diff', '--', 'drizzle']);
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

// A journal merge can satisfy the prefix rule while two snapshots keep the
// same parent. `drizzle-kit generate` reports that collision but exits 0, so
// the generation step below passes. Walk the chain here and fail loudly.
const snapshotChainError = async (): Promise<string | undefined> => {
  const entries = parseJournalEntries(await Bun.file('drizzle/meta/_journal.json').text());
  const snapshots: Array<{ path: string; id: string; prevId: string }> = [];

  for (const entry of entries) {
    const tag = isRecord(entry) && typeof entry.tag === 'string' ? entry.tag : undefined;
    if (tag === undefined) {
      return 'Drizzle migration journal entry has no tag.';
    }

    const path = `drizzle/meta/${tag}_snapshot.json`;
    const file = Bun.file(path);
    if (!(await file.exists())) {
      // The journal carries no snapshot for this entry, so there is no chain
      // to validate (synthetic fixtures and snapshot-less setups).
      return undefined;
    }

    let snapshot: unknown;
    try {
      snapshot = JSON.parse(await file.text());
    } catch {
      return `Migration snapshot ${path} is not valid JSON.`;
    }

    if (
      !isRecord(snapshot) ||
      typeof snapshot.id !== 'string' ||
      typeof snapshot.prevId !== 'string'
    ) {
      return `Migration snapshot ${path} has no id or prevId.`;
    }

    snapshots.push({ path, id: snapshot.id, prevId: snapshot.prevId });
  }

  const pathById = new Map<string, string>();
  for (const snapshot of snapshots) {
    const existingPath = pathById.get(snapshot.id);
    if (existingPath !== undefined) {
      return `Migration snapshots ${existingPath} and ${snapshot.path} declare the same id ${snapshot.id}.`;
    }
    pathById.set(snapshot.id, snapshot.path);
  }

  for (let index = 1; index < snapshots.length; index += 1) {
    const parent = snapshots[index - 1];
    const child = snapshots[index];
    if (child.prevId !== parent.id) {
      return [
        `The migration snapshot chain forks at ${child.path}: its prevId does not equal the id of ${parent.path}.`,
        "Each snapshot's prevId must equal the previous snapshot's id.",
        "Restore the chain, or regenerate the newest migration with 'bun run db:generate'.",
      ].join('\n');
    }
  }

  return undefined;
};

// CI passes the pull request base. A local run falls back to the merge-base with
// the integration branch, so the inherited-migration rules below hold before a push.
const integrationMergeBase = (): string | undefined => {
  const result = Bun.spawnSync(['git', 'merge-base', 'HEAD', 'origin/develop'], {
    stderr: 'pipe',
    stdout: 'pipe',
  });

  if (result.exitCode !== 0) return undefined;

  return result.stdout.toString().trim() || undefined;
};

const baseArgumentIndex = process.argv.indexOf('--base');
const baseReference =
  (baseArgumentIndex >= 0 ? process.argv[baseArgumentIndex + 1] : undefined) ??
  process.env.MIGRATION_BASE_REF ??
  integrationMergeBase();

if (baseArgumentIndex >= 0 && !baseReference) {
  console.error('The `--base` option requires a git revision.');
  process.exit(1);
}

if (baseReference) {
  const inheritedFilesResult = Bun.spawnSync(
    ['git', 'ls-tree', '-r', '--name-only', baseReference, '--', 'drizzle'],
    {
      stderr: 'pipe',
      stdout: 'pipe',
    }
  );

  if (inheritedFilesResult.exitCode !== 0) {
    console.error(`Unable to inspect migration history at base revision ${baseReference}.`);
    console.error(inheritedFilesResult.stderr.toString().trim());
    process.exit(1);
  }

  const inheritedSqlFiles = inheritedFilesResult.stdout
    .toString()
    .split('\n')
    .filter((path) => path.endsWith('.sql'));
  const changedSqlFiles = inheritedSqlFiles.filter((path) => {
    const comparison = Bun.spawnSync(['git', 'diff', '--quiet', baseReference, '--', path], {
      stderr: 'inherit',
      stdout: 'inherit',
    });

    return comparison.exitCode !== 0;
  });

  const migrationRepairs = await readMigrationRepairs();
  const repairByPath = new Map(migrationRepairs.map((repair) => [repair.path, repair]));
  const inheritedSqlFileSet = new Set(inheritedSqlFiles);
  const changedSqlFileSet = new Set(changedSqlFiles);
  const hasDuplicateRepairPath = repairByPath.size !== migrationRepairs.length;
  const hasInvalidRepair = migrationRepairs.some((repair) => {
    if (!repair.reason.trim() || !inheritedSqlFileSet.has(repair.path)) {
      return true;
    }

    if (!changedSqlFileSet.has(repair.path)) return false;

    const baseBlob = gitOutput(['rev-parse', `${baseReference}:${repair.path}`]).trim();
    const repairedBlob = gitOutput(['hash-object', '--', repair.path]).trim();

    return repair.baseBlob !== baseBlob || repair.repairedBlob !== repairedBlob;
  });
  const unapprovedChangedSqlFiles = changedSqlFiles.filter((path) => !repairByPath.has(path));

  if (hasDuplicateRepairPath || hasInvalidRepair || unapprovedChangedSqlFiles.length > 0) {
    console.error('Inherited migration SQL is immutable:');
    for (const path of unapprovedChangedSqlFiles) {
      console.error(`- ${path}`);
    }
    console.error(
      'Restore the inherited SQL and represent the correction in a new forward migration, or record an exact approved repair in docs/agents/migration-repairs.json.'
    );
    process.exit(1);
  }

  const inheritedJournalResult = Bun.spawnSync(
    ['git', 'show', `${baseReference}:drizzle/meta/_journal.json`],
    {
      stderr: 'pipe',
      stdout: 'pipe',
    }
  );

  if (inheritedJournalResult.exitCode === 0) {
    let inheritedEntries: unknown[];
    let currentEntries: unknown[];

    try {
      inheritedEntries = parseJournalEntries(inheritedJournalResult.stdout.toString());
      currentEntries = parseJournalEntries(await Bun.file('drizzle/meta/_journal.json').text());
    } catch {
      console.error('Unable to read the Drizzle migration journal.');
      process.exit(1);
    }

    const inheritedJournalChanged =
      currentEntries.length < inheritedEntries.length ||
      inheritedEntries.some(
        (entry, index) => JSON.stringify(currentEntries[index]) !== JSON.stringify(entry)
      );

    if (inheritedJournalChanged) {
      console.error('Inherited migration journal entries are immutable.');
      console.error('Restore the inherited journal order and create a new forward migration.');
      process.exit(1);
    }
  }
}

const chainError = await snapshotChainError();
if (chainError !== undefined) {
  console.error(chainError);
  process.exit(1);
}

const beforeGeneration = migrationArtifactSnapshot();
const generation = Bun.spawnSync(['bun', 'run', 'db:generate', '--', '--prefix', 'timestamp'], {
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
    ].join('\n')
  );
  process.exit(1);
}
