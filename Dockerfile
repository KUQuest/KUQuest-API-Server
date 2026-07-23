FROM oven/bun:1.3.14 AS base

WORKDIR /app


# Install every dependency needed to build the application
FROM base AS build-dependencies

COPY package.json bun.lock ./

RUN bun install --frozen-lockfile


# Build TypeScript into dist/index.js
FROM build-dependencies AS builder

COPY tsconfig.json ./
COPY src ./src

RUN bun run build


# Install only runtime dependencies
FROM base AS production-dependencies

COPY package.json bun.lock ./

RUN bun install --frozen-lockfile --production


# Final runtime image
FROM base AS runner

WORKDIR /app

ENV HOST=0.0.0.0
ENV PORT=5000

COPY --from=builder --chown=bun:bun /app/dist ./dist

# Keep runtime dependencies because Better Auth or other packages
# may resolve modules dynamically.
COPY --from=production-dependencies \
  --chown=bun:bun \
  /app/node_modules \
  ./node_modules

COPY --chown=bun:bun package.json ./

USER bun

EXPOSE 5000

CMD ["bun", "dist/index.js"]
