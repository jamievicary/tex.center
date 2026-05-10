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

echo "setup_node.sh: node $(node --version), pnpm $(pnpm --version)"
