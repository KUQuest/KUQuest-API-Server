# Keep Work Chat Quest-scoped with REST-authoritative delivery

Work Chat uses one Conversation per Quest, with Quest as the source of truth for
accepted participation and lifecycle. REST remains authoritative for history,
Message persistence, Read Cursor changes, reconnect gap recovery, and fallback.
Each conversation also exposes an authenticated WebSocket as an optional
low-latency write and event transport: a validated `SEND_MESSAGE` command calls
the same Message service as REST, and the sender receives a `MESSAGE_ACCEPTED`
or `MESSAGE_REJECTED` acknowledgement. A newly committed Message is still
published only to the other current recipients, while the sender uses the
acknowledgement and REST recovery if needed.

This keeps membership, idempotency, and persistence atomic in one service
contract while allowing clients to recover safely without Redis, pub/sub, or a
second Message business-rule implementation.

## Considered options

- **A generic direct-message system:** rejected because it creates a wider
  privacy and moderation surface than Quest coordination needs.
- **A separate WebSocket write implementation:** rejected because it would
  duplicate Message validation, membership, idempotency, and persistence rules.
- **Distributed fan-out:** rejected for MVP because one API instance is the
  agreed capacity and operations boundary.

Status: accepted.
