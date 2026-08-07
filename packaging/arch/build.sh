#!/usr/bin/env bash
#
# Build and install the package, with makepkg's scratch directories kept OUT of
# the repository.
#
# makepkg puts src/ and pkg/ next to the PKGBUILD by default, which here means
# inside the checkout. electron-builder walks the whole project root looking for
# node modules ("searching for node modules ... searchDir=<repo>"), so it
# descends into pkg/ — which was written under fakeroot — and dies with
#
#     EACCES: permission denied, scandir '.../packaging/arch/pkg'
#
# BUILDDIR and PKGDEST move both directories somewhere else entirely, which is
# the only fix that holds: any build tool that walks the project root would hit
# the same thing.
#
# Usage: ./build.sh            (build and install)
#        ./build.sh -s         (build only, do not install)
#        ./build.sh --clean    (throw away the scratch dir first)

set -euo pipefail

_here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
_scratch="${TMPDIR:-/tmp}/aoide-makepkg"

_args=()
for _arg in "$@"; do
    if [[ $_arg == '--clean' ]]; then
        echo "==> Removing $_scratch"
        rm -rf -- "$_scratch"
    else
        _args+=("$_arg")
    fi
done

# Nothing should ever have been written here, but a run that predates this
# script will have left both behind — and pkg/ is exactly what breaks the build.
for _stale in "$_here/pkg" "$_here/src"; do
    if [[ -e $_stale ]]; then
        echo "==> Removing stale $_stale"
        rm -rf -- "$_stale" 2>/dev/null || sudo rm -rf -- "$_stale"
    fi
done

mkdir -p -- "$_scratch/build" "$_scratch/pkg"
cd -- "$_here"

# Default to building and installing, which is what this is normally run for.
if [[ ${#_args[@]} -eq 0 ]]; then
    _args=(-si)
fi

echo "==> makepkg ${_args[*]}  (scratch: $_scratch)"
BUILDDIR="$_scratch/build" PKGDEST="$_scratch/pkg" exec makepkg "${_args[@]}"
