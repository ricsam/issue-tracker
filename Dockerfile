# syntax=docker/dockerfile:1

ARG BUN_VERSION=1.4.2

FROM oven/bun:${BUN_VERSION}-alpine AS dependencies
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM dependencies AS build
COPY . .
RUN bun run build

FROM oven/bun:${BUN_VERSION}-alpine AS production-dependencies
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:${BUN_VERSION}-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    DATA_DIR=/data \
    HOST=0.0.0.0 \
    PORT=3000

RUN mkdir -p /data && chown 1000:1000 /data
COPY --from=production-dependencies --chown=1000:1000 /app/node_modules ./node_modules
COPY --from=build --chown=1000:1000 /app/package.json ./package.json
COPY --from=build --chown=1000:1000 /app/server ./server
COPY --from=build --chown=1000:1000 /app/shared ./shared
COPY --from=build --chown=1000:1000 /app/dist ./dist

USER 1000:1000
EXPOSE 3000
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["bun", "-e", "const response = await fetch('http://127.0.0.1:3000/healthz'); if (!response.ok) process.exit(1)"]

CMD ["bun", "server/index.ts"]
