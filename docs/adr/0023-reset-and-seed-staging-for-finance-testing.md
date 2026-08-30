# Reset and seed staging for finance testing

Staging may be reset when a large database contract change makes its existing rows incompatible with the local schema. The reset drops and recreates only the staging `public` schema, applies the complete committed migration chain, and creates a verified recovery backup before the destructive step.

After the reset, staging runs the supported Admin, demo Student, and demo Quest seed scripts. A separate non-production finance seed creates deterministic Wallet balances and valid Payout Destinations through the finance services so Quest Escrow and Payout Approval can be tested. The finance seed never writes Wallet projection balances directly and never uses production provider credentials.
