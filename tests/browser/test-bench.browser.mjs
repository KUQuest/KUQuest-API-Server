import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';

// Use a separately installed Playwright package, or the optional local install.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const baseURL = process.env.TEST_BENCH_URL || 'http://localhost:5100';
const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const ok = (data) => ({ success: true, data });
let member = null;
let allowPublish = false;
let failMessage = true;
let failPayout = true;
let admin = false;
let quoteLifetime = 300000;
let walletGate = null;
const writes = [];
const messageKeys = [];
const payoutKeys = [];
const quest = { id: '00000000-0000-4000-8000-000000000001', title: 'Design a KU poster', state: 'QUEST_DRAFT', mode: 'FIRST_COME_FIRST_SERVED', participation: 'SINGLE', proofRequired: false, dueAt: '2026-09-06T10:00:00+07:00' };
const conversation = (id, readOnly) => ({ id, quest: { id: quest.id, title: `Poster ${id}`, status: readOnly ? 'QUEST_COMPLETED' : 'QUEST_IN_PROGRESS' }, readOnly });
const message = { id: 'm1', kind: 'USER', sender: { id: 'account-1', displayName: 'Hirer' }, text: 'Hello Worker', createdAt: '2026-09-05T10:00:00Z' };
await page.route('**/api/**', async (route) => {
  const request = route.request();
  const path = new URL(request.url()).pathname;
  const method = request.method();
  const body = request.postDataJSON();
  if (method !== 'GET') writes.push({ path, method, body });
  if (path === '/api/v1/wallet' && walletGate) await walletGate;
  let data;
  let status = 200;
  if (path.includes('/staging/test-auth/sign-in/')) { member = path.split('/').at(-1); data = {}; }
  else if (path === '/api/auth/get-session') data = member ? { user: { id: member, email: `${member}@ku.th` }, session: { token: 'SECRET_SESSION' } } : null;
  else if (path === '/api/auth/sign-out') { member = null; data = {}; }
  else if (path === '/api/admin/auth/get-session') data = admin ? { user: { id: 'admin', email: 'admin@test.local' } } : null;
  else if (path === '/api/admin/auth/sign-in/email') { admin = true; data = { user: { id: 'admin', email: body.email } }; }
  else if (path === '/api/admin/auth/sign-out') { admin = false; data = {}; }
  else if (path === '/api/v1/admin/payouts') data = ok({ items: [], nextCursor: null });
  else if (path === '/api/v1/tags') data = ok([{ id: 'tag-1', name: 'Design' }]);
  else if (path === '/api/v1/wallet') data = ok({ wallet: { spendingBalanceSatang: 10000, earningsBalanceSatang: 20000, fundingReservedSatang: 0, reservedForPayoutsSatang: 0 } });
  else if (path === '/api/v2/quests' && method === 'POST') { Object.assign(quest, body); data = ok(quest); }
  else if (path === '/api/v2/quests/mine' || path === '/api/v2/quests') data = ok({ items: [quest], nextCursor: null });
  else if (path.endsWith('/publish-check')) data = ok({ canPublish: allowPublish, blockingReasons: allowPublish ? [] : [{ code: 'TAG_REQUIRED', message: 'Choose a Tag.' }], escrowRequirementSatang: 10000 });
  else if (path.endsWith('/publish')) { quest.state = 'QUEST_OPEN'; data = ok({ quest }); }
  else if (path.endsWith('/cancel')) { quest.state = 'QUEST_CANCELLED'; data = ok({ questStatus: 'QUEST_CANCELLED', outcome: 'CANCELLED', paidSatang: 0, refundedSatang: 10000 }); }
  else if (path === `/api/v2/quests/${quest.id}` || path.endsWith('/public')) data = ok(quest);
  else if (path === '/api/v1/chat/conversations') data = ok({ items: [conversation('c1', false), conversation('c2', true)], nextCursor: null });
  else if (path.endsWith('/participants')) data = ok({ participants: [{ id: member, role: 'HIRER', displayName: 'Hirer' }] });
  else if (path.endsWith('/messages') && method === 'GET') data = ok({ items: [message], hasMore: false, nextCursor: null });
  else if (path.endsWith('/messages') && method === 'POST') {
    messageKeys.push(body.clientMessageId);
    if (failMessage) { failMessage = false; await route.abort('failed'); return; }
    data = ok({ message: { ...message, id: 'm2', text: body.text } });
  }
  else if (path.endsWith('/read')) data = ok({});
  else if (path === '/api/v1/payouts/quotes') data = ok({ id: 'quote-1', payoutDestinationId: 'dest-1', receiptSatang: body.receiptSatang, maximumDebitSatang: body.receiptSatang + 200, expiresAt: new Date(Date.now() + quoteLifetime).toISOString() });
  else if (path === '/api/v1/payouts' && method === 'POST') {
    payoutKeys.push(request.headers()['idempotency-key']);
    if (failPayout) { failPayout = false; await route.abort('failed'); return; }
    data = ok({ id: 'payout-1', payoutStatus: 'PENDING_ADMIN_APPROVAL' });
  }
  else if (path === '/api/v1/payouts') data = ok({ items: [], nextCursor: null });
  else if (path === '/api/local/test/payment') data = ok({ testUserEmail: 'finance-fixture@ku.th', wallet: { spendingBalanceSatang: 999999 }, topUp: {} });
  else { status = 404; data = { success: false, error: { message: `Unhandled fixture: ${method} ${path}` } }; }
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
});
const idle = async () => { await page.waitForFunction(() => !document.querySelector('.card[data-busy="true"]')); };
const click = async (id) => { await page.locator(`#${id}`).click(); await idle(); };
const nav = async (key) => { await page.locator(`[data-nav="${key}"]`).click(); await page.locator(`[data-page="${key}"]`).waitFor({ state: 'visible' }); };
try {
  await page.goto(baseURL);
  await page.waitForFunction(() => document.querySelector('#operation-count').textContent.includes('operations'));
  assert.equal(writes.length, 0, 'Opening the page must not sign in or mutate data');
  assert.equal(await page.locator('[data-page]:visible').count(), 1);
  assert.equal(await page.locator('#chat-send').isDisabled(), true);
  await click('default-sign-in');
  assert.match(await page.locator('#current-member').textContent(), /account-1/);
  assert.equal(await page.locator('#debug-log').textContent().then((text) => text.includes('SECRET_SESSION')), false);
  console.log('PASS: explicit sign-in, Session display, redacted logs');

  await nav('quests');
  await page.locator('#quest-title').fill('Design a KU poster');
  await page.locator('#quest-condition').fill('Create poster\nSend source file');
  await click('create-quest');
  const created = writes.find((item) => item.path === '/api/v2/quests');
  assert.equal(created.body.mode, 'FIRST_COME_FIRST_SERVED');
  assert.equal(created.body.participation, 'SINGLE');
  assert.deepEqual(created.body.condition.items, ['Create poster', 'Send source file']);
  assert.match(created.body.startTime, /\+07:00$/);
  assert.equal(await page.locator('#publish-quest').isDisabled(), true);
  await click('publish-check');
  assert.match(await page.locator('#quest-flow-status').textContent(), /Choose a Tag/);
  assert.equal(await page.locator('#publish-quest').isDisabled(), true);
  allowPublish = true;
  await click('publish-check'); await click('publish-quest');
  assert.match(await page.locator('#quest-summary').textContent(), /QUEST_OPEN/);
  page.once('dialog', (dialog) => dialog.accept());
  await click('cancel-quest');
  assert.match(await page.locator('#quest-summary').textContent(), /QUEST_CANCELLED/);
  assert.equal(await page.locator('#cancel-quest').isDisabled(), true);
  await click('list-mine');
  assert.equal(await page.locator('.quest-card').count(), 1);
  console.log('PASS: v2 Draft, Bangkok schedule, publication blockers, publish, Quest cards');

  await nav('chat'); await click('chat-load-live');
  await page.locator('#conversation-select').selectOption('c2'); await idle();
  assert.equal(await page.locator('#chat-message-input').isDisabled(), true);
  await page.locator('#conversation-select').selectOption('c1'); await idle();
  await page.locator('#chat-message-input').fill('Retry this Message');
  await click('chat-send');
  assert.equal(await page.locator('#chat-message-input').inputValue(), 'Retry this Message');
  assert.match(await page.locator('#action-status').textContent(), /retry/);
  await click('chat-send');
  assert.equal(messageKeys.length, 2);
  assert.equal(messageKeys[0], messageKeys[1], 'Message retry must keep clientMessageId');
  assert.equal(await page.locator('#chat-message-input').inputValue(), '');
  console.log('PASS: live Conversation selection, read-only state, failed send, deduplicated retry');

  await nav('wallet');
  let releaseWallet;
  walletGate = new Promise((resolve) => { releaseWallet = resolve; });
  await page.locator('#refresh-wallet').click();
  await page.waitForFunction(() => document.querySelector('[aria-labelledby=wallet-heading]').dataset.busy === 'true');
  await nav('chat');
  releaseWallet(); walletGate = null; await idle();
  console.log('PASS: navigation remains available while a request is pending');
  await nav('wallet'); await click('quote-payout');
  assert.equal(await page.locator('#submit-payout').isDisabled(), false);
  await page.locator('#payout-amount').fill('120.50');
  assert.equal(await page.locator('#submit-payout').isDisabled(), true);
  await click('quote-payout'); await click('submit-payout'); await click('submit-payout');
  assert.equal(payoutKeys[0], payoutKeys[1], 'Payout retry must keep Idempotency-Key');
  assert.equal(await page.locator('#submit-payout').isDisabled(), true);
  assert.match(await page.locator('#payout-status').textContent(), /PENDING_ADMIN_APPROVAL/);
  quoteLifetime = 100;
  await click('quote-payout'); await page.waitForTimeout(1200);
  assert.equal(await page.locator('#submit-payout').isDisabled(), true);
  await click('run-payment');
  assert.match(await page.locator('#wallet-member').textContent(), /account-1/);
  console.log('PASS: Payout amount changes, Quote expiry, idempotent submit, separate finance test Member');

  await nav('admin');
  await page.locator('#admin-email').fill('admin@test.local');
  await page.locator('#admin-password').fill('fake-test-password');
  await click('admin-sign-in');
  assert.equal(await page.locator('#admin-payout-workspace').isVisible(), true);
  assert.equal(await page.locator('#admin-payout-previous').isDisabled(), true);
  assert.equal(await page.locator('#admin-payout-next').isDisabled(), true);
  await click('admin-sign-out');
  console.log('PASS: Admin Session and empty Approval Queue');

  await nav('explorer');
  await page.locator('#operation-search').fill('publish');
  assert.ok(await page.locator('.operation').count() > 0);
  assert.equal(await page.locator('.operation input[name="questId"]').first().inputValue(), quest.id);
  await page.locator('#operation-search').fill('/api/v1/payouts/quotes');
  const quoteOperation = page.locator('.operation').first();
  await quoteOperation.locator('summary').click();
  await quoteOperation.locator('textarea').fill(JSON.stringify({ receiptSatang: 1500 }));
  await quoteOperation.locator('button[type=submit]').click();
  await page.waitForFunction(() => document.querySelector('.operation pre').textContent.includes('maximumDebitSatang'));
  assert.equal(writes.at(-1).body.receiptSatang, 1500, 'Explorer must not rescale API Satang fields');
  await page.locator('#operation-search').fill('no-such-operation');
  assert.match(await page.locator('#operation-list').textContent(), /No operations/);
  await nav('member'); await click('account-2-sign-in');
  assert.equal(await page.locator('#quest-id').inputValue(), '');
  assert.equal(await page.locator('#chat-messages .chat-message').count(), 0);
  assert.equal(await page.locator('#submit-payout').isDisabled(), true);
  console.log('PASS: API search, selected Quest reuse, clear old Member data');

  await mkdir('/tmp/kuquest-bench-verification', { recursive: true });
  // Each check navigates the same browser page; these steps must run in order.
  /* eslint-disable no-await-in-loop */
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const key of ['member', 'quests', 'chat', 'wallet', 'admin', 'explorer', 'log']) {
      await nav(key);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `Overflow: ${key} at ${width}px`);
    }
    await nav('member');
    await page.screenshot({ path: `/tmp/kuquest-bench-verification/member-${width}.png`, fullPage: true });
  }
  assert.deepEqual(errors, []);
  console.log('PASS: all seven sections at desktop and phone sizes; no browser errors');
} finally { await browser.close(); }
