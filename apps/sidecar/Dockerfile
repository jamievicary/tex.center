# Multi-stage build for the @tex-center/sidecar shared per-project
# Machine. Carries full TeX Live + Python 3 (the supertex CLI is a
# Python script) + the supertex C artefacts (LD_PRELOAD shim,
# daemon, helper tools) + the sidecar Node app.
#
# Build context is the repo root (see apps/sidecar/.dockerignore).
# The full pnpm workspace is needed at install time so the
# `workspace:*` deps in apps/sidecar (blobs, db, protocol) resolve.
#
# **Engine binary.** The runtime image needs a patched `luatex`
# (a.k.a. `lualatex-append` / `lualatex-incremental`) on `$PATH`.
# We vendor the prebuilt ELF at `vendor/engine/<arch>/lualatex-
# incremental` and COPY it into the runtime stage; the `.fmt` is
# regenerated against this image's `texlive-full`. See
# `vendor/engine/README.md` for provenance and the future
# source-build path.

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
# tools). `vendor/supertex` is a git submodule. `make` with no
# target defaults to the first prerequisite-only rule (just
# `baseline_snapshot`); pass `all` so we get `build/supertex` +
# `build/supertex_daemon` + the shim + helper tools.
COPY vendor/supertex/ vendor/supertex/
RUN make -C vendor/supertex -j all

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
    HOST=:: \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:/opt/engine/bin:$PATH \
    SIDECAR_COMPILER=supertex-daemon \
    SUPERTEX_BIN=/opt/supertex/build/supertex
RUN apt-get update && apt-get install -y --no-install-recommends \
        texlive-full \
        python3 \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

# The vendored engine ELF was compiled with SELFAUTO-derived default
# search paths rooted at `/opt/engine`, so kpathsea can't find Debian's
# `texmf.cnf` on its own (it lives under /usr/share/texlive and
# /etc/texmf). Set TEXMFCNF explicitly so both the fmt-dump RUN below
# and runtime invocations via the wrapper resolve correctly; Debian's
# texmf.cnf hard-codes absolute TEXMF* paths so once kpathsea reads it
# the rest follows.
#
# This MUST come after the texlive-full apt-install: the `context`
# package's postinst runs `luatools --make cont-en` against its own
# texmf tree, and a TEXMFCNF that only mentions /usr/share/texlive
# would break it (iter 88: setting TEXMFCNF before apt-install caused
# `context (--configure)` to fail and the whole layer to abort).
ENV TEXMFCNF=/etc/texmf/web2c:/usr/share/texlive/texmf-dist/web2c

WORKDIR /opt/repo
COPY --from=builder /repo /opt/repo

# Stable path for the supertex CLI and its C artefacts.
RUN ln -sfn /opt/repo/vendor/supertex /opt/supertex

# Patched lualatex engine. The vendored ELF is the actual binary;
# /opt/engine/bin/lualatex-incremental is a tiny wrapper that points
# TEXFORMATS at the locally-dumped fmt before exec-ing the ELF.
# `lualatex-append` is a symlink so supertex's `find_engine` (which
# probes both names) is happy whichever it tries first.
COPY vendor/engine/x86_64-linux/lualatex-incremental /opt/engine/binary
RUN mkdir -p /opt/engine/bin /opt/engine/web2c \
    && printf '%s\n' \
        '#!/bin/sh' \
        'export TEXFORMATS="${TEXFORMATS:-/opt/engine/web2c}"' \
        'exec /opt/engine/binary --fmt=lualatex "$@"' \
        > /opt/engine/bin/lualatex-incremental \
    && chmod +x /opt/engine/bin/lualatex-incremental \
    && ln -s lualatex-incremental /opt/engine/bin/lualatex-append

# Dump lualatex.fmt against this image's texlive-full + the patched
# engine. Mirrors the maintainer's local setup_smoketest.sh logic:
# run --ini in a scratch dir, drop the resulting fmt into
# /opt/engine/web2c/. Caches into a stable layer so iterating on
# Node/sidecar code above doesn't rebuild the fmt.
RUN scratch="$(mktemp -d)" \
    && cd "$scratch" \
    && /opt/engine/binary --ini --interaction=nonstopmode \
        --jobname=lualatex lualatex.ini < /dev/null \
    && test -s lualatex.fmt \
    && mv lualatex.fmt /opt/engine/web2c/lualatex.fmt \
    && rm -rf "$scratch"

EXPOSE 3001
CMD ["pnpm", "--filter", "@tex-center/sidecar", "start"]
