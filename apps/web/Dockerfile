# Multi-stage build for the @tex-center/web control plane.
#
# Build context is the repo root (see apps/web/.dockerignore and the
# `flyctl deploy --dockerfile apps/web/Dockerfile` invocation in CD).
# We need the full pnpm workspace at install time so that the
# `workspace:*` deps in apps/web (auth, db, protocol) resolve.
#
# adapter-node bundles all third-party deps into apps/web/build/, so
# the runtime stage carries only that directory plus Node itself —
# no node_modules, no pnpm.

ARG NODE_VERSION=20.18.1
ARG PNPM_VERSION=9.12.0

# ---------- builder ----------
FROM node:${NODE_VERSION}-bookworm-slim AS builder
ARG PNPM_VERSION
ENV CI=1 \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

WORKDIR /repo

# Manifests first so the install layer caches across source edits.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json .npmrc tsconfig.base.json ./
COPY apps/web/package.json apps/web/
COPY apps/sidecar/package.json apps/sidecar/
COPY packages/auth/package.json packages/auth/
COPY packages/blobs/package.json packages/blobs/
COPY packages/db/package.json packages/db/
COPY packages/protocol/package.json packages/protocol/

RUN pnpm install --frozen-lockfile

# Source. Copy only what apps/web's build needs: the web app itself
# plus its workspace deps (auth, db, protocol). The sidecar and
# blobs package are not in apps/web's import graph.
COPY apps/web/ apps/web/
COPY packages/auth/ packages/auth/
COPY packages/db/ packages/db/
COPY packages/protocol/ packages/protocol/

RUN pnpm --filter @tex-center/web build

# ---------- runtime ----------
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0
WORKDIR /app
COPY --from=builder /repo/apps/web/build ./build
# adapter-node emits ESM; Node treats files as CJS unless a sibling
# package.json declares `"type": "module"`. Stub one in /app.
RUN echo '{"type":"module"}' > package.json
EXPOSE 3000
CMD ["node", "build/index.js"]
