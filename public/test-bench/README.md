# KUQuest API Test Bench

Run `bun run dev`, then open the API Server root URL. The Server serves the
HTML, CSS, and JavaScript directly. No frontend build is required.

The workspace has seven sections: Member, Quests, Work Chat, Wallet & Payout,
Admin Approval, API explorer, and Request log. Navigation works with browser
Back and Forward and with links such as `/#chat`.

1. Sign in explicitly with a configured test Member or Google. Test accounts
   require staging test authentication. Opening the page does not sign in.
2. As the Hirer, create a v2 Draft with the selection mode, participation shape,
   ordered Condition Items, funding, and schedule. Schedule inputs use
   Asia/Bangkok time. Select a Tag before publication.
3. Check publication and resolve the Server's blockers before publishing.
   The API explorer contains Draft edits and other advanced Quest actions.
   Select a Quest first to fill its ID in the explorer. v1 Quest actions are
   marked as Legacy Implementation.
4. Switch Members from the Member section. Work Chat lists live Work
   Conversations. It never supplies demo Messages. Select a Conversation;
   use Refresh to load new Messages and Load older Messages for history.
5. For a Payout, get a Quote before submitting. An amount change, Member
   change, successful submission, or Quote expiry invalidates that Quote.
   A separate Admin Session opens the Approval Queue.

The local finance test tools act on configured finance test Members, which
can differ from the signed-in Member. Their responses do not replace the
signed-in Member's Wallet display. They require the local finance test routes.

Request JSON and diagnostic output use the exact API names and units; money
fields ending in `Satang` are integers. Balance summaries and ordinary money
inputs use Baht. Logs redact sensitive fields and are held only in page memory.
Message and Payout retries preserve their command IDs while the page is open.

## Verification

The regular `bun run check` includes the HTTP asset tests. The browser suite
uses the real page and OpenAPI document, with controlled API responses for
state-changing operations. It does not send real payments, Messages, or
Admin decisions.

Install Playwright outside the repository to keep the runtime dependency set
unchanged, then run:

```bash
npm install --prefix /tmp/kuquest-browser-tools playwright
/tmp/kuquest-browser-tools/node_modules/.bin/playwright install chromium
PORT=5100 bun src/index.ts
# In another terminal:
PLAYWRIGHT_MODULE_PATH=/tmp/kuquest-browser-tools/node_modules/playwright/index.mjs \
TEST_BENCH_URL=http://localhost:5100 \
node tests/browser/test-bench.browser.mjs
```

Set `CHROMIUM_PATH` to use an existing Chromium executable. The suite checks
explicit sign-in, navigation, v2 Draft creation, publication blockers,
cancellation, Conversation selection, read-only chat, failed Message retries,
Payout Quote expiry and retries, Admin sign-in, API search, and Member data
reset. It checks all sections at 1440px and 390px widths and saves screenshots
under `/tmp/kuquest-bench-verification`.

Live Google OAuth, external payment providers, and a full multi-Member Quest
lifecycle still require a configured test environment. Browser fixtures do
not prove those integrations.
