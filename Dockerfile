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

FROM node:22-slim
WORKDIR /app
# Same build deps for the runtime install (better-sqlite3 is in dependencies).
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ && \
    rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
RUN mkdir -p /app/data
EXPOSE 3005
CMD ["node", "dist/index.js"]
