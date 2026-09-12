# Multi-stage build for a minimal Node 22 runtime image.
# NOTE: the base tag is floating (no digest), so rebuilds are not bit-reproducible;
# pin a digest here if the deployment needs reproducibility.
FROM node:22-slim AS builder

WORKDIR /build

# Install dependencies (dev deps included: tsc is needed to build)
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# Copy sources and build
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build

# Drop dev dependencies from the installed tree
RUN npm prune --omit=dev

FROM node:22-slim

WORKDIR /app

COPY --from=builder --chown=node:node /build/node_modules ./node_modules
COPY --from=builder --chown=node:node /build/dist ./dist
COPY --chown=node:node package.json ./
COPY --chown=node:node --chmod=755 docker-entrypoint.sh ./docker-entrypoint.sh

# Create the data directory. Ownership is re-applied at boot by the entrypoint,
# because a volume mounted here (Railway) replaces it with a root-owned dir and
# would otherwise break every upload with EACCES.
RUN mkdir -p /data && chown -R node:node /data

ENV NODE_ENV=production
ENV PORT=8844

# Starts as root only long enough to fix the data dir ownership, then drops to
# node (see docker-entrypoint.sh).
ENTRYPOINT ["/app/docker-entrypoint.sh"]

EXPOSE 8844

# No USER directive on purpose: the entrypoint needs root to fix the volume
# ownership, then drops to the unprivileged node user before exec'ing the server.

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://localhost:' + (process.env.PORT || '8844') + '/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "dist/main.js"]
