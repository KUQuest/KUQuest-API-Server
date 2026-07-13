-- Schema snapshot alignment migration.
--
-- The structural SQL was reviewed and applied in 0001, followed by custom
-- PostgreSQL security and invariant objects in 0002. This tracked no-op was
-- generated in Docker so drizzle/meta has a complete snapshot for future
-- drizzle-kit generate operations without replaying duplicate CREATE TABLEs.
SELECT 1;
