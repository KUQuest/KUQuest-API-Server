# Keep the Wallet ledger scoped as a subledger

The ledger proves Student Wallet balances, funding reservations, Payout reserves, Platform Fee revenue, and provider clearing; it is not KUQuest's complete corporate accounting ledger. Provider invoices, corporate bank balances, tax accounting, and general-ledger reporting remain outside this subsystem so the Wallet implementation does not invent an accounting product beyond its use cases.
