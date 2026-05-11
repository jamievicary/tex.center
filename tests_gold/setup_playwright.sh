#!/usr/bin/env bash
# Idempotent Playwright Chromium provisioner.
#
# Installs the Playwright-managed Chromium build into
# `.tools/playwright/` (gitignored). Re-running this script is a
# no-op once the browser binary is present.
#
# DrvFs (/mnt/c on WSL2) workaround mirrors setup_node.sh: on /mnt/*
# checkouts, `.tools/playwright` is a symlink to
# ~/.cache/tex-center-pw/<sha1-of-checkout-path>/ on ext4, because
# Playwright's browser unpack does its own atomic-rename dance that
# loses races against Windows file watchers.
#
# Assumes Node + pnpm are already provisioned by setup_node.sh and
# that `pnpm install` has populated `node_modules/` with
# `@playwright/test`.

set -euo pipefail

cd "$(dirname "$0")/.."

if [[ ! -x .tools/node/bin/node ]]; then
    bash tests_normal/setup_node.sh
fi
export PATH="$PWD/.tools/node/bin:$PATH"

checkout_root="$PWD"
target_dir="$checkout_root/.tools/playwright"

mkdir -p .tools
if [[ "$checkout_root" == /mnt/* ]]; then
    hash=$(printf '%s' "$checkout_root" | sha1sum | cut -c1-12)
    cache_dir="$HOME/.cache/tex-center-pw/$hash"
    mkdir -p "$cache_dir"
    if [ -e .tools/playwright ] && [ ! -L .tools/playwright ]; then
        echo "setup_playwright.sh: migrating .tools/playwright onto ext4 ($cache_dir)..."
        rm -rf .tools/playwright
    fi
    if [ ! -L .tools/playwright ] || [ "$(readlink .tools/playwright)" != "$cache_dir" ]; then
        rm -f .tools/playwright
        ln -s "$cache_dir" .tools/playwright
        echo "setup_playwright.sh: .tools/playwright -> $cache_dir"
    fi
else
    mkdir -p "$target_dir"
fi

export PLAYWRIGHT_BROWSERS_PATH="$target_dir"

# Skip if both the full Chromium and the headless-shell binaries
# are already present. Path layout is
# `<browsers_path>/chromium-<build>/chrome-linux/chrome` and
# `<browsers_path>/chromium_headless_shell-<build>/chrome-linux/headless_shell`.
have_chromium=0
have_headless=0
if ls "$target_dir"/chromium-*/chrome-linux/chrome >/dev/null 2>&1; then
    have_chromium=1
fi
if ls "$target_dir"/chromium_headless_shell-*/chrome-linux/headless_shell >/dev/null 2>&1; then
    have_headless=1
fi
if [ "$have_chromium" -ne 1 ] || [ "$have_headless" -ne 1 ]; then
    echo "setup_playwright.sh: installing Chromium..."
    pnpm exec playwright install chromium
fi

echo "setup_playwright.sh: ready ($target_dir)"
