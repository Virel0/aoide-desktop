# Aoide as a Flatpak

One command on any Linux with Flatpak:

```sh
cd packaging/flatpak && ./build.sh
```

Then `flatpak run io.github.Virel0.Aoide`, or find Aoide in the launcher.
`./build.sh --bundle` also writes a single `aoide.flatpak` file next to the
repository, which installs anywhere with `flatpak install aoide.flatpak`.

## What is in it

mpv is **built into the sandbox** at `/app/bin/mpv`. A Flatpak cannot reach the
host's mpv, and Aoide's MPV backend is what gives gapless playback and the wider
format support, so it comes along. It is built audio-only: nothing in Aoide asks
mpv to draw a frame, so every GPU backend is left out and the build is a fraction
of the full player's.

Codecs come from `org.freedesktop.Platform.codecs-extra`, which Flatpak installs
alongside. Without it the runtime's own ffmpeg would refuse some of what a
personal library holds.

## Moving your data across

A Flatpak keeps its data in its own directory, so a Flatpak Aoide starts empty
even if the packaged one on the same machine is full. Playlists and history sync
back from the server on the first sync, but the settings and the OpenRouter key
do not. To carry everything over before the first run:

```sh
mkdir -p ~/.var/app/io.github.Virel0.Aoide/config
cp -r ~/.config/Aoide ~/.var/app/io.github.Virel0.Aoide/config/
```

Both can be installed at once; they will not see each other's data.

The application identifier is `io.github.Virel0.Aoide`, which is the convention
for a project that lives on GitHub rather than on a domain of its own. It
changed from an earlier one in 1.15.3; a Flatpak installed from 1.15.2 is a
different application as far as Flatpak is concerned, so remove that one first:

```sh
flatpak uninstall com.gabereglat.aoide.desktop
```

## Updating

Re-run `./build.sh` after a `git pull`. For updates without building, see
`packaging/arch/release/README.md` — a tagged release publishes a pacman
repository, and the app checks GitHub for releases on its own.

## Why the app is built outside the manifest

flatpak-builder builds with no network, which is right for reproducibility and
wrong for `pnpm install`. Vendoring every npm dependency into the manifest is the
usual answer and it is a lot of generated JSON to keep in step. `build.sh` runs
the same electron-builder step the Arch package runs and the manifest installs
its output, so there is one build of the app and two ways to package it.

The consequence: the manifest cannot be built straight from a git checkout by
`flatpak-builder` alone. Always go through `build.sh`, or run the electron-builder
step first yourself.
