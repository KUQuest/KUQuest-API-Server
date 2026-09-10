# Quest owns its Command records

A Quest API v2 write command records its identity and its result as a Quest
Command in the Quest-owned `quest_command` table. It does not write the
`wallet_idempotency_keys` table, because ADR-0009 keeps the money subsystem
independent of the Quest model and finance tables hold foreign keys into that
table. The Quest Command table keeps a composite unique key on the principal,
the operation scope, and the Idempotency-Key, so two Members can send the same
Idempotency-Key for different commands. It also keeps the `quest_id` foreign
key with `ON DELETE CASCADE`.

When a business rule rejects the command, the Server records the rejection in
the Quest Command and completes it. The Server does not delete the Quest
Command. A retry with the same Idempotency-Key therefore replays the same
rejection, and one Idempotency-Key never gives two different answers.

Scope: Quest API v2 only. Quest settlement, Quest API v1, Work Chat, and the
money subsystem keep their own command tables.

Status: accepted.
