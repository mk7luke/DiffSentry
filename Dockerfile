# ── Stage 1: build the Vite SPA (web/) ───────────────────────────────
FROM node:22-slim AS web-builder
WORKDIR /web
COPY web/package.json web/package-lock.json* ./
RUN npm ci
COPY web/ ./
RUN npm run build
# → /web/dist (static SPA bundle)

# ── Stage 2: build the TypeScript server (src/) ──────────────────────
FROM node:22-slim AS builder
WORKDIR /app
# better-sqlite3 needs build tools to compile its native binding.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ && \
    rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ── Stage 3: runtime (single container serves API + webhook + SPA) ───
FROM node:22-slim
WORKDIR /app
# Same build deps for the runtime install (better-sqlite3 is in dependencies).
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ && \
    rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
# SPA bundle sits at /app/web/dist — server.ts serves it from ../web/dist
# relative to the compiled dist/ directory.
COPY --from=web-builder /web/dist ./web/dist
RUN mkdir -p /app/data
EXPOSE 3005
CMD ["node", "dist/index.js"]
