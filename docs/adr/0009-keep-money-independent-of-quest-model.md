# Keep money independent of the unfinished Quest model

The money subsystem does not create Quest Escrow tables, Quest or assignment foreign keys, per-slot records, or Quest-specific services before the Quest model exists. It exposes a generic Funding Reservation with an opaque caller reference and remaining amount, operated through transaction-aware reserve, increase, release, and partial-settlement services. Each separately idempotent settlement credits one recipient's Earnings Balance and optional Platform Fee revenue; the future Quest module decides what a reservation represents and composes these primitives inside its transaction.

The generic boundary does not prevent a narrow, transaction-aware Wallet
adapter from protecting Wallet-owned ledger and projection invariants for a
domain correction. Such an adapter accepts only opaque Wallet identifiers and
integer amounts; it does not read Quest rows, own Quest State, or expose an
HTTP route. The Admin Dispute Case adapter is this exception: Wallet owns the
balanced correction and its `wallet_dispute_settlements` audit projection,
while the Quest/Admin service supplies the already-authorized Worker and
Funding Reservation reference.
