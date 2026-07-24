# Shared auth guard as an Elysia plugin, not per-route session checks

Each onboarding route re-implemented the same three lines: call `auth.api.getSession`, return 401 if null, then use `session.user.id`. We extracted this into `src/modules/auth/auth.guard.ts`, an Elysia plugin using `.derive`/`.onBeforeHandle`, applied once per route group via `.use(authGuard)`.

Elysia's `.derive` can't narrow `session` to non-null across the plugin boundary, even though `onBeforeHandle` guarantees it by the time a handler runs. Rather than let each controller assert `session!.user.id`, the guard adds a `.resolve()` after the `onBeforeHandle` check that re-derives `session` as `NonNullable<...>` once, and exports that narrowed type as `AuthenticatedSession`. The one unsafe cast this requires lives in `auth.guard.ts` alone; downstream controllers (`onboarding.controller.ts`) type against `AuthenticatedSession` and never assert `!`.

Status: accepted.
