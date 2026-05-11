# Multi-stage build for the @tex-center/sidecar shared per-project
# Machine. Carries full TeX Live + Python 3 (the supertex CLI is a
# Python script) + the supertex C artefacts (LD_PRELOAD shim,
# daemon, helper tools) + the sidecar Node app.
#
# Build context is the repo root (see apps/sidecar/.dockerignore).
# The full pnpm workspace is needed at install time so the
# `workspace:*` deps in apps/sidecar (blobs, db, protocol) resolve.
#
# **Engine binary.** The runtime image expects a `lualatex-append`
# or `lualatex-incremental` binary on PATH at `/opt/engine/bin/`.
# Provisioning that binary is M7.0.1 (build from the patched
# luatex source or vendor a prebuilt artefact); the runtime stage
# below leaves a clearly-marked TODO until that lands.

ARG NODE_VERSION=20.18.1
ARG PNPM_VERSION=9.12.0

# ---------- builder ----------
FROM node:${NODE_VERSION}-bookworm-slim AS builder
ARG PNPM_VERSION
ENV CI=1 \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
        python3 \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*
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

# Workspace sources the sidecar imports.
COPY apps/sidecar/ apps/sidecar/
COPY packages/blobs/ packages/blobs/
COPY packages/db/ packages/db/
COPY packages/protocol/ packages/protocol/

# Typecheck the sidecar + its workspace deps so a drift between
# this image and the source tree fails the build instead of the
# Machine.
RUN pnpm --filter @tex-center/sidecar typecheck

# Build supertex C artefacts (LD_PRELOAD shim + daemon + helper
# tools). `vendor/supertex` is a git submodule.
COPY vendor/supertex/ vendor/supertex/
RUN make -C vendor/supertex -j

# ---------- runtime ----------
# Stays on the Node base image so `tsx` / pnpm work out of the
# box; texlive-full + python3 land via apt. Image is ~5GB by
# design ("full TeX Live" per GOAL.md); slim variants are a
# future optimisation.
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ARG PNPM_VERSION
ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    PORT=3001 \
    HOST=0.0.0.0 \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:/opt/engine/bin:$PATH \
    SIDECAR_COMPILER=supertex \
    SUPERTEX_BIN=/opt/supertex/src/supertex
RUN apt-get update && apt-get install -y --no-install-recommends \
        texlive-full \
        python3 \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

WORKDIR /opt/repo
COPY --from=builder /repo /opt/repo

# Stable path for the supertex CLI and its C artefacts.
RUN ln -sfn /opt/repo/vendor/supertex /opt/supertex

# TODO(M7.0.1): drop the patched `lualatex-incremental` (or
# `lualatex-append`) binary into /opt/engine/bin so the supertex
# CLI's engine lookup succeeds at startup.

EXPOSE 3001
CMD ["pnpm", "--filter", "@tex-center/sidecar", "start"]
