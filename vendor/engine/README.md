# vendor/engine — patched lualatex binary

`supertex` requires a patched build of `luatex` (referred to upstream
as `lualatex-append` or `lualatex-incremental`) to expose the
in-band shipout signal and the append-mode page emission supertex's
LD_PRELOAD shim wraps. Until M7.0.1 the sidecar Docker image had a
`TODO` placeholder where the engine binary should live; this
directory satisfies that.

## Layout

- `x86_64-linux/lualatex-incremental` — stripped ELF, dynamically
  linked against glibc (max requested version: `GLIBC_2.34`, so it
  runs on Debian bookworm and later). Built from the patched
  upstream luatex tree at
  `github.com/jamievicary/luatex-incremental@aa053dd` plus uncommitted
  local changes in the maintainer's working tree as of 2026-05-01.
  This is the same artefact `~/.luatex-append/binary` symlinks to on
  the maintainer's machine, copied verbatim.

The `.fmt` file is **not** vendored — it depends on the texlive
distribution the binary runs against, so the sidecar Dockerfile's
runtime stage regenerates it (against the image's `texlive-full`)
on first build and caches the result in `/opt/engine/web2c/`.

## Why a binary rather than a build-from-source stage

The patched luatex tree carries the full texlive `source/` directory
(~19MB git, far more on disk). A clean `./build.sh` against it takes
~30 minutes of CPU and pulls in autoconf + a long-tail of build deps.
That cost paid on every `flyctl deploy` (or every cache-miss layer
above the source COPY) would make iteration painful. The vendored
binary keeps the sidecar image build to the texlive-full apt step
plus the supertex `make` — both already on the path.

The cost is reproducibility: the binary in this directory was built
from a *dirty* working tree (`aa053dd-dirty` per `git describe`).
Future work — tracked in `.autodev/FUTURE_IDEAS.md` — should push
those local changes upstream and pin the submodule to a clean
commit, so the binary here can be regenerated bit-for-bit.

## Wrapper script

`x86_64-linux/lualatex-incremental` is the **raw ELF**, named to
match what `supertex`'s `find_engine` looks up on `$PATH`. The
Dockerfile installs a tiny shell wrapper at `/opt/engine/bin/
lualatex-incremental` that points `TEXFORMATS` at the
freshly-dumped `lualatex.fmt`, mirroring the maintainer's local
`~/bin/lualatex-append` setup. Both `lualatex-append` and
`lualatex-incremental` are accepted names; the wrapper symlink
covers the other.

## Architecture coverage

Only `x86_64-linux` for now (Fly Machines + GitHub Actions runners
are both x86_64 Linux). If the project ever needs arm64 the
directory structure (`vendor/engine/<arch>/`) already accommodates
it; the Dockerfile will need a matching `--platform`-aware COPY.
