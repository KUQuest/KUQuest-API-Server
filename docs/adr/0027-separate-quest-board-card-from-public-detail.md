# Separate the Quest Board Card from Public Quest Detail

Quest v2 uses a compact `Quest Board Card` for Board discovery and a separate
`Public Quest Detail` projection at `/api/v2/quests/:questId/public`. This keeps
mobile Board payloads small, lets Members request the full Quest Condition and
Quest Images on demand, and makes the Public projection's Finance exclusions
explicit instead of making one path return role-dependent schemas.

Status: accepted.
