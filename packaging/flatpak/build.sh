#!/usr/bin/env bash
#
# Build and install Aoide as a Flatpak, from this checkout.
#
# Usage: ./build.sh              build and install for this user
#        ./build.sh --bundle     also write aoide.flatpak next to the repo
#        ./build.sh --skip-app   reuse the last electron-builder output
#
# The Electron app is built first, by the same electron-builder step the Arch
# package uses; the manifest then installs what it produced. flatpak-builder
# builds offline, so building the app inside it would mean vendoring every npm
# dependency for no gain.
set -euo pipefail

_here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
_repo="$(cd -- "$_here/../.." && pwd)"
_app_id='com.gabereglat.aoide.desktop'
_manifest="$_here/$_app_id.yml"
# Kept out of the repository: electron-builder walks the project root looking
# for node modules and descends into anything left inside it.
_scratch="${TMPDIR:-/tmp}/aoide-flatpak"

_bundle=false
_skip_app=false
for _arg in "$@"; do
    case "$_arg" in
        --bundle) _bundle=true ;;
        --skip-app) _skip_app=true ;;
        *) echo "unknown option: $_arg" >&2; exit 2 ;;
    esac
done

for _tool in flatpak flatpak-builder; do
    if ! command -v "$_tool" >/dev/null 2>&1; then
        echo "error: $_tool is not installed." >&2
        echo "       On Arch:  sudo pacman -S flatpak flatpak-builder" >&2
        exit 1
    fi
done

echo '==> Making sure the runtimes are present'
flatpak remote-add --user --if-not-exists flathub https://dl.flathub.org/repo/flathub.flatpakrepo
flatpak install --user --or-update --noninteractive flathub \
    org.freedesktop.Platform//25.08 \
    org.freedesktop.Sdk//25.08 \
    org.electronjs.Electron2.BaseApp//25.08 \
    org.freedesktop.Platform.ffmpeg-full//25.08

if [[ $_skip_app == false ]]; then
    echo '==> Building the app'
    cd -- "$_repo"
    pnpm install --frozen-lockfile
    pnpm run build:electron
    # `dir` stops at the unpacked tree, which is what the manifest installs.
    pnpm exec electron-builder --linux dir --publish never
fi

if [[ ! -d $_repo/dist/linux-unpacked ]]; then
    echo "error: $_repo/dist/linux-unpacked is missing; run without --skip-app." >&2
    exit 1
fi

mkdir -p -- "$_scratch"
cd -- "$_here"

_args=(--user --install --force-clean --state-dir "$_scratch/state")
if [[ $_bundle == true ]]; then
    _args+=(--repo "$_scratch/repo")
fi

echo "==> flatpak-builder  (scratch: $_scratch)"
flatpak-builder "${_args[@]}" "$_scratch/build" "$_manifest"

if [[ $_bundle == true ]]; then
    flatpak build-bundle "$_scratch/repo" "$_repo/../aoide.flatpak" "$_app_id" --runtime-repo=https://dl.flathub.org/repo/flathub.flatpakrepo
    echo "==> Wrote $(cd "$_repo/.." && pwd)/aoide.flatpak"
fi

echo '==> Installed. Run it with:  flatpak run com.gabereglat.aoide.desktop'
