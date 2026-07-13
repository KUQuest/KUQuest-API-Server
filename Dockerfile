FROM oven/bun:1.3.14-alpine

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .

RUN chown -R bun:bun /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=5000

EXPOSE 5000

USER bun

CMD ["bun", "run", "start"]
