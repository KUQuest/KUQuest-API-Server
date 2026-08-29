import { sql } from '@/database/client';
import { processApprovedPayouts } from '@/modules/payout';

try {
  const processed = await processApprovedPayouts();
  console.log(JSON.stringify({ processed }));
} catch (cause) {
  console.error('Payout worker failed', cause);
  process.exitCode = 1;
} finally {
  await sql.end();
}
