# Multi-stage build for a minimal Node 22 runtime image
FROM node:22-slim AS builder

WORKDIR /build

# Install dependencies (dev deps included: tsc is needed to build)
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund

# Copy sources and build
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# Drop dev dependencies from the installed tree
RUN npm prune --omit=dev

FROM node:22-slim

WORKDIR /app

COPY --from=builder /build/node_modules ./node_modules
COPY --from=builder /build/dist ./dist
COPY package.json ./

# Create the data directory
RUN mkdir -p /data

ENV NODE_ENV=production
ENV PORT=8844

EXPOSE 8844

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://localhost:' + (process.env.PORT || '8844') + '/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "dist/main.js"]
