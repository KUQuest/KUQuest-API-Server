import {
  STAGING_DATABASE_RESET_CONFIRMATION,
  parseDatabaseTarget,
  validateStagingResetEnvironment,
} from '../../scripts/reset-staging-database-warning-wipe-out-whole-database';

import { describe, expect, it } from 'bun:test';

describe('staging database reset command', () => {
  it('requires the staging environment and exact destructive confirmation', () => {
    expect(() =>
      validateStagingResetEnvironment({
        NODE_ENV: 'development',
        DEPLOYMENT_ENV: 'development',
        CONFIRM_STAGING_DATABASE_RESET: STAGING_DATABASE_RESET_CONFIRMATION,
      })
    ).toThrow('NODE_ENV=production and DEPLOYMENT_ENV=staging');

    expect(() =>
      validateStagingResetEnvironment({
        NODE_ENV: 'production',
        DEPLOYMENT_ENV: 'staging',
        CONFIRM_STAGING_DATABASE_RESET: 'wrong confirmation',
      })
    ).toThrow(STAGING_DATABASE_RESET_CONFIRMATION);
  });

  it('builds a maintenance connection and rejects system databases', () => {
    expect(
      parseDatabaseTarget('postgres://kuquest:secret@postgres:5432/kuquest?sslmode=disable')
    ).toEqual({
      databaseName: 'kuquest',
      maintenanceDatabaseUrl: 'postgres://kuquest:secret@postgres:5432/postgres?sslmode=disable',
    });

    expect(() => parseDatabaseTarget('postgres://kuquest:secret@postgres:5432/postgres')).toThrow(
      'refuses to reset the PostgreSQL system database'
    );
  });
});
