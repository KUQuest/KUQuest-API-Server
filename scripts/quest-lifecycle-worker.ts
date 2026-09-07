import { sql } from '@/database/client';
import { runQuestLifecycleWorker } from '@/modules/quest/quest-lifecycle.worker';

try {
  const result = await runQuestLifecycleWorker();
  console.log(JSON.stringify(result));
} catch (cause) {
  console.error('Quest lifecycle worker failed', cause);
  process.exitCode = 1;
} finally {
  await sql.end();
}
