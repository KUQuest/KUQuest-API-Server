import { sql } from '@/database/client';
import { seedQuestTags } from '@/modules/tag/tag.service';

const main = async (): Promise<void> => {
  const result = await seedQuestTags();
  console.log(`Seeded ${result.total} quest tags (${result.removed} legacy tags removed).`);
};

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Quest tag seed failed.');
  process.exitCode = 1;
} finally {
  await sql.end();
}
