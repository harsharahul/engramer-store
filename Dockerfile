# Engramer Store - self-hostable, end-to-end encrypted cloud storage
#
# Build:  docker build -t engramer-store .
# Run:    docker run -d --name engramer -p 3080:3080 -v engramer-data:/data engramer-store
#         then open http://localhost:3080 and create a vault.
FROM node:26-bookworm-slim AS build

# Toolchain for the better-sqlite3 native module when no prebuild matches.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g pnpm@11

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @engramer/web build

# Production dependencies only, for the server and its workspace packages.
FROM node:26-bookworm-slim AS proddeps

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g pnpm@11

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/crypto/package.json packages/crypto/package.json
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
RUN CI=true pnpm install --frozen-lockfile --prod --filter @engramer/server...

FROM node:26-bookworm-slim

LABEL org.opencontainers.image.title="Engramer Store" \
      org.opencontainers.image.description="Self-hostable, end-to-end encrypted cloud storage" \
      org.opencontainers.image.source="https://github.com/harsharahul/engramer-store" \
      org.opencontainers.image.licenses="AGPL-3.0-only"

ENV NODE_ENV=production \
    ENGRAMER_HOST=0.0.0.0 \
    ENGRAMER_PORT=3080 \
    ENGRAMER_DATA_DIR=/data \
    ENGRAMER_WEB_DIST=/app/apps/web/dist

COPY --from=proddeps /app /app
COPY packages/crypto/src /app/packages/crypto/src
COPY apps/server/src /app/apps/server/src
COPY --from=build /app/apps/web/dist /app/apps/web/dist

# Vault state lives on a mounted volume; run as the image's unprivileged user.
RUN mkdir -p /data && chown node /data
USER node
WORKDIR /app/apps/server
EXPOSE 3080
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
    CMD node -e "fetch('http://127.0.0.1:3080/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["./node_modules/.bin/tsx", "src/index.ts"]
