#!/usr/bin/env bash
#
# Build akochan (the expected-value verifier) on macOS.
#
# akochan is vendored, not committed: vendor/ is gitignored, so this script is
# the reproducible record of how the binary was produced. Run it from anywhere.
#
#   ./scripts/build-akochan.sh
#
# Produces vendor/akochan/system.exe and vendor/akochan/libai.so.
#
# Two upstream assumptions no longer hold on a current Homebrew, and both are
# handled here rather than by editing the vendored source:
#
#   1. `-lboost_system`. Boost.System became header-only in 1.69 and the
#      compiled stub was dropped entirely by 1.90, so the flag names a library
#      that no longer exists.
#
#   2. `boost::asio::io_service`, `address::from_string` and `buffer_cast`, all
#      removed in Boost 1.87. They are used only by akochan's TcpClient — the
#      networked mjai path, which this project never takes (we drive
#      `pipe_detailed` over stdin/stdout instead). Patching three call sites in
#      upstream's socket code to satisfy a compiler for a code path we do not
#      execute is a worse trade than pinning Boost, so we pin: boost@1.85
#      predates all three removals.
#
# Homebrew LLVM is required because Apple's clang ships neither OpenMP nor Polly.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AKOCHAN="$ROOT/vendor/akochan"

if [ ! -d "$AKOCHAN" ]; then
  echo "akochan is not vendored yet; cloning" >&2
  mkdir -p "$ROOT/vendor"
  git clone --depth 1 https://github.com/critter-mj/akochan.git "$AKOCHAN"
fi

for formula in llvm boost@1.85; do
  if ! brew --prefix "$formula" >/dev/null 2>&1; then
    echo "missing dependency: brew install $formula" >&2
    exit 1
  fi
done

LLVM_BASE="$(brew --prefix llvm)"
BOOST_BASE="$(brew --prefix boost@1.85)"

# The vendored makefiles resolve boost with `brew --prefix boost`, which finds
# the unusable current version; override it. CFLAGS is recursively expanded, so
# overriding BOOST_BASE also redirects the include path.
COMMON=(BOOST_BASE="$BOOST_BASE" LLVM_BASE="$LLVM_BASE")

echo "==> libai.so"
# `-Wl,-rpath,@loader_path` rather than upstream's `./`: the loader path is
# relative to the binary, so system.exe finds libai.so regardless of the
# working directory it is spawned from.
make -C "$AKOCHAN/ai_src" -f Makefile_MacOS "${COMMON[@]}" \
  LIBS="-L$LLVM_BASE/lib -L$BOOST_BASE/lib -lboost_system"

echo "==> system.exe"
make -C "$AKOCHAN" -f Makefile_MacOS "${COMMON[@]}" \
  LIBS="-L$LLVM_BASE/lib -L$BOOST_BASE/lib -lboost_system -L./ -Wl,-rpath,@loader_path -lai"

echo
echo "built:"
ls -la "$AKOCHAN/system.exe" "$AKOCHAN/libai.so"
echo
# akochan reads params/ with paths relative to the *working directory*, so it
# must always be spawned with cwd set to the akochan root. pipeline/verify.py
# does this; a wrong cwd yields unread parameters rather than a clean error.
echo "note: run system.exe with cwd=$AKOCHAN (params/ paths are cwd-relative)"
