# Reset and seed staging for finance testing

Staging may be reset when a large database contract change makes its existing rows incompatible with the local schema. The reset drops and recreates only the staging `public` schema, applies the complete committed migration chain, and creates a verified recovery backup before the destructive step.

After the reset, staging runs the supported Admin, demo Student, and demo Quest seed scripts. A separate non-production finance seed creates deterministic Wallet balances and valid Payout Destinations through the finance services so Quest Escrow and Payout Approval can be tested. The finance seed never writes Wallet projection balances directly and never uses production provider credentials.

## Demo flow update (2026-10-02)

The dedicated Member seed now creates the only 10 demo identities. A dedicated
Quest step seeds starter funds with sealed Ledger Transactions and publishes one
funded Quest per Member through the v2 service, leaving ฿1,000 available. These
same Members are used by mobile debug login. The separate finance, frontend,
image, and staging-test-user seed entry points are removed. Payout and Dispute
scenarios remain covered by integration fixtures rather than demo bootstrap.
