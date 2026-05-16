# Multi-stage build for the @tex-center/web control plane.
#
# Build context is the repo root (see apps/web/.dockerignore and the
# `flyctl deploy --dockerfile apps/web/Dockerfile` invocation in CD).
# We need the full pnpm workspace at install time so that the
# `workspace:*` deps in apps/web (auth, db, protocol) resolve.
#
# adapter-node's Rollup pass keeps anything under `node_modules` as a
# bare-specifier external (workspace deps are symlinks and get inlined,
# regular npm deps like `jose` do not). The runtime stage therefore
# needs a real `node_modules` containing the prod dep closure, or the
# first import of e.g. `jose` from `googleTokens.ts` throws
# `ERR_MODULE_NOT_FOUND` at request time. We produce that closure with
# `pnpm deploy --prod` in the builder and copy it into the runtime
# image. See discussion/129 for the latent-since-day-one incident
# (callback 500ing on `Cannot find package 'jose'`).

ARG NODE_VERSION=20.18.1
ARG PNPM_VERSION=9.12.0

# ---------- builder ----------
FROM node:${NODE_VERSION}-bookworm-slim AS builder
ARG PNPM_VERSION
ARG TEXCENTER_ITER=dev
ENV CI=1 \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    PUBLIC_TEXCENTER_ITER=$TEXCENTER_ITER
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
# plus its workspace deps (auth, blobs, db, protocol). `blobs`
# became reachable from the web SSR graph in iter 323 when
# `coldSourceFor` was wired into `+page.server.ts` and the
# resolver's `seedDocFor`. The sidecar is still not in the import
# graph.
COPY apps/web/ apps/web/
COPY packages/auth/ packages/auth/
COPY packages/blobs/ packages/blobs/
COPY packages/db/ packages/db/
COPY packages/protocol/ packages/protocol/

RUN pnpm --filter @tex-center/web build

# Produce a self-contained prod-only dep closure. `pnpm deploy`
# resolves `workspace:*` to copies, prunes devDeps, and respects the
# lockfile. We only consume the resulting `node_modules` in the
# runtime stage — the deploy's source-tree copy is discarded.
RUN pnpm --filter @tex-center/web --prod deploy /prod

# ---------- runtime ----------
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ARG TEXCENTER_ITER=dev
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    PUBLIC_TEXCENTER_ITER=$TEXCENTER_ITER
WORKDIR /app
COPY --from=builder /repo/apps/web/build ./build
COPY --from=builder /prod/node_modules ./node_modules
# Migrations are read at runtime by `runBootMigrations` (see
# `src/lib/server/bootMigrations.ts`) when
# `RUN_MIGRATIONS_ON_BOOT=1`. Path matches `DEFAULT_MIGRATIONS_DIR`;
# override with `MIGRATIONS_DIR` if needed.
COPY --from=builder /repo/packages/db/src/migrations ./migrations
# adapter-node emits ESM; Node treats files as CJS unless a sibling
# package.json declares `"type": "module"`. Stub one in /app.
RUN echo '{"type":"module"}' > package.json
EXPOSE 3000
CMD ["node", "build/server.js"]
