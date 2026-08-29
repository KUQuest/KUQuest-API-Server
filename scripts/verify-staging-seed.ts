import { env } from '@/config/env';
import { sql } from '@/database/client';
import { getWallet } from '@/modules/wallet';

const demoEmails = [
  'nattapong.srisawat@ku.th',
  'warisara.boonmee@ku.th',
  'thanakrit.chaiyasit@ku.th',
  'supitcha.wongsakul@ku.th',
  'kritchapon.phromma@ku.th',
  'aphinya.sukjai@ku.th',
  'pattarapon.ruangrit@ku.th',
  'chutimon.thepsuriya@ku.th',
  'ekkapop.wattana@ku.th',
  'nichakan.kaewmanee@ku.th',
] as const;

const financeQuestTitle = '[Finance Test] Publish Escrow Quest Draft';
const financeSeedRemainingEarningsSatang = 400_000;

const requiredValue = (name: string, value: string | undefined): string => {
  if (!value?.trim()) throw new Error(`${name} is required for staging seed verification.`);
  return value.trim();
};

const readCount = async (
  query: PromiseLike<readonly { count?: number | string }[]>,
): Promise<number> => {
  const [row] = await query;
  return Number(row?.count ?? 0);
};

const assertAtLeast = (label: string, actual: number, expected: number): void => {
  if (actual < expected) throw new Error(`${label} verification failed.`);
};

const main = async (): Promise<void> => {
  const adminEmail = requiredValue('ADMIN_EMAIL', process.env.ADMIN_EMAIL).toLowerCase();
  const financeEmail = requiredValue('STAGING_TEST_AUTH_EMAIL', env.stagingTestAuthEmail).toLowerCase();
  const recipientEmail = requiredValue(
    'LOCAL_FINANCE_TEST_RECIPIENT_EMAIL',
    env.localFinanceTestRecipientEmail,
  ).toLowerCase();

  const adminCount = await readCount(sql`
    SELECT count(*)::int AS count
    FROM auth_admin
    WHERE lower(email) = ${adminEmail}
  `);
  assertAtLeast('Admin', adminCount, 1);

  const demoCount = await readCount(sql`
    SELECT count(*)::int AS count
    FROM auth_user
    WHERE email = ANY(${sql.array([...demoEmails])})
  `);
  if (demoCount !== demoEmails.length) throw new Error('Demo Student seed verification failed.');

  const openQuestCount = await readCount(sql`
    SELECT count(*)::int AS count
    FROM quest
    WHERE title LIKE '[Demo] %' AND quest_status = 'QUEST_OPEN'
  `);
  const completedQuestCount = await readCount(sql`
    SELECT count(*)::int AS count
    FROM quest
    WHERE title LIKE '[Demo] %' AND quest_status = 'QUEST_COMPLETED'
  `);
  assertAtLeast('Demo OPEN Quest', openQuestCount, 1);
  assertAtLeast('Demo COMPLETED Quest', completedQuestCount, 1);

  const assignmentCount = await readCount(sql`
    SELECT count(*)::int AS count
    FROM quest_assignment assignment
    INNER JOIN quest ON quest.id = assignment.quest_id
    WHERE quest.title LIKE '[Demo] %' AND quest.quest_status = 'QUEST_COMPLETED'
  `);
  const reviewCount = await readCount(sql`
    SELECT count(*)::int AS count
    FROM review
    INNER JOIN quest ON quest.id = review.quest_id
    WHERE quest.title LIKE '[Demo] %' AND quest.quest_status = 'QUEST_COMPLETED'
  `);
  assertAtLeast('Demo Assignment', assignmentCount, 1);
  assertAtLeast('Demo Review', reviewCount, 2);

  const financeStudentCount = await readCount(sql`
    SELECT count(*)::int AS count
    FROM auth_user
    WHERE lower(email) = ${financeEmail}
  `);
  const financeRecipientCount = await readCount(sql`
    SELECT count(*)::int AS count
    FROM auth_user
    WHERE lower(email) = ${recipientEmail}
  `);
  assertAtLeast('Finance test Student', financeStudentCount, 1);
  assertAtLeast('Finance test recipient', financeRecipientCount, 1);

  const [financeStudent] = await sql<{ id: string }[]>`
    SELECT id
    FROM auth_user
    WHERE lower(email) = ${financeEmail}
    LIMIT 1
  `;
  if (!financeStudent) throw new Error('Finance test Student verification failed.');

  const financeWallet = await getWallet(financeStudent.id);
  if (
    financeWallet.spendingBalanceSatang < 1_000_000 ||
    financeWallet.earningsBalanceSatang < financeSeedRemainingEarningsSatang
  ) {
    throw new Error('Finance Wallet balances verification failed.');
  }

  const destinationCount = await readCount(sql`
    SELECT count(*)::int AS count
    FROM payment_payout_accounts destination
    INNER JOIN auth_user member ON member.id = destination.user_id
    WHERE lower(member.email) = ${financeEmail} AND destination.retired_at IS NULL
  `);
  assertAtLeast('Finance Payout Destination', destinationCount, 1);

  const pendingPayoutCount = await readCount(sql`
    SELECT count(*)::int AS count
    FROM payment_payouts payout
    INNER JOIN auth_user member ON member.id = payout.user_id
    WHERE lower(member.email) = ${financeEmail}
      AND payout.payout_status = 'PENDING_ADMIN_APPROVAL'
  `);
  assertAtLeast('Finance pending Payout', pendingPayoutCount, 1);

  const financeDraftCount = await readCount(sql`
    SELECT count(*)::int AS count
    FROM quest draft
    INNER JOIN auth_user member ON member.id = draft.hirer_id
    WHERE lower(member.email) = ${financeEmail} AND draft.title = ${financeQuestTitle}
      AND draft.quest_status = 'QUEST_DRAFT'
  `);
  assertAtLeast('Finance Quest Escrow draft', financeDraftCount, 1);

  console.log('Verified Admin, demo Quest, Assignment, Review, Wallet, Payout Destination, pending Payout, and finance draft seeds.');
};

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Staging seed verification failed.');
  process.exitCode = 1;
} finally {
  await sql.end();
}
