import { resolve } from 'node:path';

import { describe, expect, it } from 'bun:test';

const repoRoot = resolve(import.meta.dir, '..', '..', '..');
const allowedPublisherImports: Record<string, string> = {
  'src/modules/academic-registration/academic-registration.service.ts':
    'The Admin barrel loads Wallet routes; a runtime import fails in wallet.admin.service before createAdminActionService initializes.',
  'src/modules/auth/auth.config.ts':
    'The Admin barrel loads Wallet routes; a runtime import fails in wallet.admin.service before createAdminActionService initializes.',
  'src/modules/admin/member-penalty/member-penalty.service.ts':
    'The Admin barrel loads Wallet routes; a runtime import fails in wallet.admin.service before createAdminActionService initializes.',
  'src/modules/certificate/certificate.service.ts':
    'The Admin barrel loads Wallet routes; a runtime import fails in wallet.admin.service before createAdminActionService initializes.',
  'src/modules/onboarding/onboarding.service.ts':
    'The Admin barrel loads Wallet routes; a runtime import fails in wallet.admin.service before createAdminActionService initializes.',
  'src/modules/profile/profile.service.ts':
    'The Admin barrel loads Wallet routes; a runtime import fails in wallet.admin.service before createAdminActionService initializes.',
  'src/modules/quest/shared/admin-updates.ts':
    'The Admin barrel loads Wallet routes; a runtime import fails in wallet.admin.service before createAdminActionService initializes.',
  'src/modules/quest/shared/command/quest-command.service.ts':
    'The Admin barrel loads Wallet routes; a runtime import fails in wallet.admin.service before createAdminActionService initializes.',
  'src/modules/quest/v1/services/quest-review.service.ts':
    'The Admin barrel loads Wallet routes; a runtime import fails in wallet.admin.service before createAdminActionService initializes.',
  'src/modules/quest/v2/core/quest-v2-edit.service.ts':
    'The Admin barrel loads Wallet routes; a runtime import fails in wallet.admin.service before createAdminActionService initializes.',
  'src/modules/quest/v2/core/quest-v2.service.ts':
    'The Admin barrel loads Wallet routes; a runtime import fails in wallet.admin.service before createAdminActionService initializes.',
  'src/modules/quest/v2/review/quest-review-v2.service.ts':
    'The Admin barrel loads Wallet routes; a runtime import fails in wallet.admin.service before createAdminActionService initializes.',
  'src/modules/work-experience/work-experience.service.ts':
    'The Admin barrel loads Wallet routes; a runtime import fails in wallet.admin.service before createAdminActionService initializes.',
  'src/modules/work-chat/message-report.service.ts':
    'The Admin barrel loads Wallet routes; a runtime import fails in wallet.admin.service before createAdminActionService initializes.',
};
const publisherImport = /from\s+['"]@\/modules\/admin\/admin-update\.delivery['"]/;

describe('Admin update publisher import boundary', () => {
  it('documents source files that must bypass the cyclic Admin barrel', async () => {
    const sourceFiles = [
      ...new Bun.Glob('src/**/*.ts').scanSync({ cwd: repoRoot, onlyFiles: true }),
    ];
    const sources = await Promise.all(
      sourceFiles.map(async (file) => ({
        file,
        source: await Bun.file(resolve(repoRoot, file)).text(),
      }))
    );
    const foundAllowedImports = new Set<string>();
    const offenders: string[] = [];

    for (const { file, source } of sources) {
      if (!publisherImport.test(source)) continue;
      if (allowedPublisherImports[file]) {
        foundAllowedImports.add(file);
      } else {
        offenders.push(`${file} imports the Admin publisher through an undocumented deep path.`);
      }
    }

    for (const [file, reason] of Object.entries(allowedPublisherImports)) {
      if (!foundAllowedImports.has(file)) {
        offenders.push(`${file} has a stale publisher exception: ${reason}`);
      }
    }

    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});
