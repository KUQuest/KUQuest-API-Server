# Make the ledger the financial source of truth

The immutable, balanced double-entry ledger is authoritative for financial state; Wallet balances and activity history are projections updated atomically with it. PostgreSQL rejects changes to sealed transactions and refuses to seal an unbalanced transaction, supplementing the application services' checks. This keeps fast reads and a user-facing activity feed without allowing either denormalized view to independently define balances or Quest Escrow state.
