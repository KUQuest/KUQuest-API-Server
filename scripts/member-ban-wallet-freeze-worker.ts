import { sql } from '@/database/client';
import { processExpiredMemberBanWalletFreezes } from '@/modules/admin/member-penalty';

try {
  const processed = await processExpiredMemberBanWalletFreezes();
  console.log(JSON.stringify({ processed }));
} catch (cause) {
  console.error('Member Ban Wallet freeze worker failed', cause);
  process.exitCode = 1;
} finally {
  await sql.end();
}
