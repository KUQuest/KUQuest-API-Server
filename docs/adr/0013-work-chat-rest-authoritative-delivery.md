# Keep Work Chat Quest-scoped with REST-authoritative recovery

Work Chat uses one Conversation per Quest, with Quest as the source of truth for
accepted participation and lifecycle. REST is authoritative for history,
Message creation, Read Cursor changes, and reconnect gap recovery; a
process-local WebSocket sends committed events at least once. This keeps
membership and persistence atomic while allowing clients to recover safely
without Redis, pub/sub, or a second write protocol.

## Considered options

- **A generic direct-message system:** rejected because it creates a wider
  privacy and moderation surface than Quest coordination needs.
- **WebSocket writes:** rejected because it would create a second commit and
  idempotency contract for Message and Read Cursor operations.
- **Distributed fan-out:** rejected for MVP because one API instance is the
  agreed capacity and operations boundary.

Status: accepted.
