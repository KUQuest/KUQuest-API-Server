# Development money test UI

The root page is a Thai, development-only user journey for verifying the KUQuest MVP money flow. It behaves like the product rather than an administrator console. Google sign-in remains the entry point and accepts only `@ku.th` accounts.

## Run locally

1. Start PostgreSQL and apply migrations.
2. Configure Better Auth and Xendit test-mode environment values.
3. Start the API with `bun run dev` and open `http://localhost:5000`.
4. Sign in, create synthetic users, and use the actor tabs to move between employer and worker workspaces.

The suggested journey is employer top-up, funded job creation, worker application and submission, employer approval, then worker earnings conversion or payout. Synthetic users start with zero balances and invoke the same money and job endpoints as ordinary users.

## Receive real Xendit test webhooks

Start the API first, then run:

```sh
bun run tunnel
```

The helper checks local health and starts a Cloudflare Quick Tunnel. Copy the generated `https://*.trycloudflare.com` origin into `PUBLIC_API_URL`, then configure these endpoints in the Xendit test-mode dashboard:

```text
https://<generated-host>.trycloudflare.com/v1/webhooks/xendit/payments
https://<generated-host>.trycloudflare.com/v1/webhooks/xendit/payouts
```

Use the same verification token configured as `XENDIT_WEBHOOK_TOKEN`. Keep the browser and Google OAuth callback on `http://localhost:5000`; the tunnel exists only for inbound Xendit webhooks. Quick Tunnel URLs are temporary and change after restart.

The Xendit simulation button calls Xendit's real test-only payment simulator. A simulator response does not credit KUQuest by itself: the authenticated webhook remains authoritative.

## Diagnostics and privacy

The collapsible drawer stores at most 250 browser request entries in memory. Reloading or closing the tab removes them. Copy and JSON download recursively redact cookies, authorization, credentials, tokens, account numbers, QR values, raw bodies, and provider payloads.

The drawer also reads the development-only sanitized diagnostics endpoint for balanced ledger postings and webhook processing state. It has no mutation controls. Full account details, QR payloads, webhook bodies, and provider secrets must never be added to this endpoint or browser logs.

The idempotency replay controls resend either the identical latest mutation or the same key with a deliberately changed body. Use the latter only to verify the expected `IDEMPOTENCY_CONFLICT` behavior.
