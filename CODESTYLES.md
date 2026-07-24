# Code Styles

Observed conventions in this repo — there's no Prettier/ESLint config enforcing formatting (`oxlint` only checks correctness/suspicious/perf, no style rules), so this file is the source of truth until one exists.

## Formatting

- 2-space indentation, single quotes, semicolons everywhere.
  - Exception: `src/modules/onboarding/*` currently uses 4-space indentation — a pre-existing deviation, not the target. Match the file you're in; don't spread 4-space to new modules.
- `strict: true` in `tsconfig.json` — no implicit `any` beyond deliberate escape hatches (see Elysia section below).

## Imports

Grouped in this order, each group separated by a blank line:

1. Path-aliased imports (`@/...`, resolves to `./src/*`)
2. Third-party packages (`elysia`, `drizzle-orm`, etc.)
3. Relative imports (`./...`)

```ts
import { authGuard } from '@/modules/auth/auth.guard';
import { API_V1_PREFIX } from '@/shared/api-version';

import { Elysia } from 'elysia';

import { getOnboardingStatus } from './onboarding.controller';
```

Use the `@/*` alias for cross-module imports; relative imports only within the same module.

## Module layout

Each feature is a directory under `src/modules/<name>/` split by layer, one file per layer, named `<module>.<layer>.ts`:

- `<module>.route.ts` — thin Elysia wiring only: path, guard, schema, pointer to controller function. No business logic, no direct DB access.
- `<module>.controller.ts` — handler functions. Orchestrates service calls, shapes the response, sets `set.status` for non-200 cases.
- `<module>.service.ts` — the only place that touches `db` (Drizzle). Routes and controllers never import `db` directly.
- `<module>.schema.ts` — Elysia `t.Object` schemas for body/response validation.
- `index.ts` — barrel file re-exporting the module's public surface (route plugin, and any types/functions used outside the module). Add one once external imports reach into more than one of the module's files; skip it while only a single export is needed.

See `src/modules/onboarding/` as the reference shape.

## Elysia-specific patterns

- **Auth**: use the shared `authGuard` plugin (`src/modules/auth/auth.guard.ts`) via `.use(authGuard)` — never re-implement a session check inline in a route.
- **Session typing**: controllers type their context's `session` as `AuthenticatedSession` (exported from `auth.guard.ts`), not the raw nullable session — the guard has already narrowed it. Don't write `session!`.
- **Response codes**: build `response` schema objects with the shared `responses()` helper (`src/shared/api-response.schema.ts`), e.g. `responses(mySuccessSchema, 401, 404)`. Don't hand-write `{ 200: ..., 401: ..., 404: ... }` per route.
- **Status codes in handlers**: set `set.status = 404` (etc.) and return the error body directly, rather than Elysia's `status()` helper — `status()`'s return type is narrowed per-route by TypeBox generics and doesn't compose across a controller file extracted from the route.
- **Response envelope**: every success/error return uses `apiSuccess()`/`apiError()` from `src/shared/api-response.ts`, matching the shared `ApiResponse`/`ApiSuccess`/`ApiError` types. Don't hand-roll `{success, data}` objects.
- **Versioning**: API resource routes prefix with `` `${API_V1_PREFIX}/<resource>` `` (`src/shared/api-version.ts`). Infra/OAuth routes (health check, auth mount) stay unversioned.

## Naming

- Files: `kebab-or-camel.layer.ts` matching the module name (e.g. `onboarding.controller.ts`, `auth.guard.ts`).
- Exports: named exports only, no default exports.
- Types: `PascalCase`; values/functions: `camelCase`; constants: `camelCase` unless truly global config (`API_V1_PREFIX`, `ALLOWED_EMAIL_DOMAIN` are `SCREAMING_SNAKE_CASE`).

## Testing

- Integration-first: `tests/modules/<name>/<name>.integration.test.ts` hits the real `app` via `app.handle(new Request(...))`, not mocks.
- Test structure mirrors `src/` — one test dir per module/shared/plugin/database area.
