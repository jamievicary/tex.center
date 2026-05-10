#!/usr/bin/env bash
# Idempotent Node 20 LTS provisioner for this repo.
#
# Installs into .tools/node-v<VERSION>-linux-x64 and points
# .tools/node at it. Activates pnpm via corepack at the version
# pinned in root package.json (`packageManager` field).
#
# .tools/ is gitignored. Re-running this script is a no-op when the
# binary is already present and pnpm is already activated.

set -euo pipefail

NODE_VERSION="20.18.1"
ARCH="linux-x64"
TARBALL="node-v${NODE_VERSION}-${ARCH}.tar.xz"
URL="https://nodejs.org/dist/v${NODE_VERSION}/${TARBALL}"

cd "$(dirname "$0")/.."

mkdir -p .tools
cd .tools

if [ ! -x "node-v${NODE_VERSION}-${ARCH}/bin/node" ]; then
    echo "setup_node.sh: fetching Node ${NODE_VERSION}..."
    wget -q --timeout=60 --tries=2 "$URL"
    tar -xf "$TARBALL"
    rm "$TARBALL"
fi

ln -sfn "node-v${NODE_VERSION}-${ARCH}" node

export PATH="$PWD/node/bin:$PATH"

if ! command -v pnpm >/dev/null 2>&1; then
    echo "setup_node.sh: enabling pnpm via corepack..."
    corepack enable >/dev/null
fi

# DrvFs (/mnt/c on WSL2) cannot host pnpm's package layout reliably:
# Windows file watchers hold transient handles that race pnpm's
# atomic-rename install step, producing EACCES. Workaround: stash
# `node_modules/` on an ext4-backed cache dir under $HOME and link
# it back into the checkout. Hoisted-linker keeps the layout flat
# enough that Node's resolution algorithm walks correctly through
# the symlink (the cache dir's parent is a real path containing a
# `node_modules` child, which is what Node's walk-up looks for).
cd ..
checkout_root="$PWD"
if [[ "$checkout_root" == /mnt/* ]]; then
    hash=$(printf '%s' "$checkout_root" | sha1sum | cut -c1-12)
    cache_parent="$HOME/.cache/tex-center-nm/$hash"
    cache_nm="$cache_parent/node_modules"
    mkdir -p "$cache_nm"
    if [ -e node_modules ] && [ ! -L node_modules ]; then
        # A previous direct `pnpm install` left a real dir; try to
        # migrate. Move what we can; leftover entries (locked by
        # Windows handles) get nuked best-effort.
        echo "setup_node.sh: migrating node_modules onto ext4 ($cache_nm)..."
        mv node_modules "$cache_parent/migrated_$$" 2>/dev/null || true
        rm -rf "$cache_parent/migrated_$$" 2>/dev/null || true
    fi
    if [ ! -L node_modules ] || [ "$(readlink node_modules)" != "$cache_nm" ]; then
        rm -f node_modules
        ln -s "$cache_nm" node_modules
        echo "setup_node.sh: node_modules -> $cache_nm"
    fi
fi
cd .tools

echo "setup_node.sh: node $(node --version), pnpm $(pnpm --version)"
