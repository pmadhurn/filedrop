# --- build ------------------------------------------------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /app
# better-sqlite3 falls back to compiling from source when no prebuild matches
# the platform (arm64 here), so the toolchain has to be present at install time.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

# --- runtime ----------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public

# The data volume is created from this path, so it inherits this ownership and
# the unprivileged runtime user can write to it.
RUN mkdir -p /data/db /data/storage /data/tmp /data/logs \
 && chown -R node:node /data /app \
 && chmod -R 700 /data

USER node
EXPOSE 8140

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8140)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/server.js"]
