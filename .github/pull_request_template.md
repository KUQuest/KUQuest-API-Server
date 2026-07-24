## Summary

<!-- Explain what changed and why. Link the Linear issue. -->

## Verification

<!-- List the commands or controlled checks you ran. -->

## Database-change checklist

Choose the first item when this pull request does not change the database
schema. Otherwise complete all remaining items.

- [ ] No database schema change — migration work is not applicable.
- [ ] Schema changes include generated SQL and Drizzle metadata.
- [ ] Generated SQL was reviewed for the intended data and schema behavior.
- [ ] `bun run db:check` passed with the generated artifacts present.
- [ ] The migration was tested against PostgreSQL 17.
