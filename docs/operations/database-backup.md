# Production database backup

This backup protects the KUQuest PostgreSQL database on `192.168.1.211`. It
stores the backup on the separate PVE host `192.168.1.100`.

## Policy and timing

| Item | Configuration |
| --- | --- |
| Backup type | Full PostgreSQL backup; no incremental backup |
| Database | `kuquest` in Docker container `postgres-db` |
| Backup times | `00:00` and `12:00`, `Asia/Bangkok` |
| Retention | 7 × 24 hours on PVE |
| RPO | 12 hours, when both scheduled jobs succeed |
| RTO | 4 hours or less; measured by the restore test |
| Backup storage | `/mnt/manga-storage/dump/kuquest-db` on PVE |

The database host uses UTC. The cron file sets `CRON_TZ=Asia/Bangkok`, so the
schedule uses Bangkok time.

```cron
CRON_TZ=Asia/Bangkok
0 0,12 * * * root /usr/local/sbin/kuquest-db-backup >> /var/log/kuquest-db-backup.log 2>&1
0 3 1 * * root /usr/local/sbin/kuquest-db-restore-test >> /var/log/kuquest-db-restore-test.log 2>&1
```

## Backup flow

The job runs as `root` on `192.168.1.211`:

1. `flock` prevents two backup jobs from running at the same time.
2. `docker exec` runs `pg_dump --format=custom` inside `postgres-db` for the
   `kuquest` database.
3. The dump is written to a local `.partial` file under
   `/var/backups/kuquest-db`.
4. `pg_restore --list` checks that the archive is readable.
5. The local file is renamed to its final name and its size and SHA-256 checksum
   are calculated.
6. `scp` sends the file to PVE through a restricted SSH key and the
   `kuquest-backup` account.
7. PVE checks the file size and checksum. Only then is the `.partial` file
   renamed to the final `.dump` file.
8. PVE deletes completed dumps older than 7 days and partial files older than
   1 day.
9. After successful verification, the local completed dump is removed and the
   last-success record is updated.

File names use UTC timestamps, for example:

```text
kuquest-20260910T102335Z.dump
```

## Failure behavior

- A failed `pg_dump` or archive validation removes the local partial file.
- A failed transfer or checksum validation does not update `last-success`.
- A completed local dump remains when transfer fails, so an administrator can
  investigate or retry it.
- The cron log contains the error and the job exits with a failure status.

## Restore test

The monthly restore test runs on the first day of each month at `03:00`
Bangkok time. It can also be run manually:

```bash
/usr/local/sbin/kuquest-db-restore-test
```

The test:

1. Downloads the newest `.dump` file from PVE.
2. Starts an isolated PostgreSQL 17 container.
3. Runs `pg_restore --exit-on-error`.
4. Checks the `auth_user` table and Drizzle migration table.
5. Records the elapsed time.
6. Removes the temporary database container and dump.

The test must complete within the 4-hour RTO. The test log is:

```text
/var/log/kuquest-db-restore-test.log
```

## Status and security

```text
/var/lib/kuquest-db-backup/last-success
/var/log/kuquest-db-backup.log
```

The PVE backup account has no sudo access. The SSH key is restricted by source
address and SSH options. The backup directory uses mode `700`; backup files
use mode `600`. SSH protects the transfer, but the files are not encrypted at
rest on PVE.

## Scope

This procedure backs up PostgreSQL data only. It does not back up RustFS file
objects such as Member avatars, Quest Images, Certificates, or Chat
Attachments. A production restore must also recreate required PostgreSQL roles;
cluster-wide roles are not included in the normal database dump.
