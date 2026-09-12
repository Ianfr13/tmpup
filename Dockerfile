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

# Create the data directory and run as the unprivileged node user. The COPY
# steps already chown the app tree to node (the repo files are mode 600), so no
# world-readable chmod is needed.
RUN mkdir -p /data && chown -R node:node /data

ENV NODE_ENV=production
ENV PORT=8844

USER node

EXPOSE 8844

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://localhost:' + (process.env.PORT || '8844') + '/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "dist/main.js"]
