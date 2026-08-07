# Handoff

Three pieces, three conversations. This one is the desktop client: forked, renamed,
packaged, and confirmed installed and running on the target machine — but it is still
Feishin. None of the Aoide half exists yet.

| | where | repo | state |
| --- | --- | --- | --- |
| **Aoide iOS** | `~/Jelly music` | `Virel0/aoide` (private) | shipped, on the phone |
| **Aoide sidecar** | *(other chat)* | `Virel0/aoide-sidecar` (public) | working, syncing |
| **Aoide desktop** | `~/aoide-desktop` | `Virel0/aoide-desktop` (private) | installs and runs on CachyOS; no sync yet |

The specification both existing implementations were written against is
`docs/sync-design.md` — a copy sits in this repo. `docs/aoide-integration.md` is the
build order for this client and the traps worth knowing before starting.

## Where the iOS app got to

SwiftUI, iOS 26, Swift 6 strict concurrency. Three local packages under `Packages/`,
all of which also build and pass on Linux (measured, in a `swift:6.1-noble`
container): **JellyfinKit** (77 tests) the API layer, **CurationKit** (358) the local
store, op log, sync engine, smart playlists, blobs, and **PlaybackKit** (46) queue and
engine — the engine behind `#if os(iOS)`.

Built and working: Apple Music-style UI, gapless playback (130ms → 57ms on FLAC,
measured), line-level lyrics, CarPlay, Siri, downloads with artwork and lyrics,
offline launch, natural-language search via Apple Intelligence, AirPlay, Spotlight,
SharePlay, local playlists, smart playlists, folders, play history, skip tracking,
queue persistence, playlist covers, and sync against the sidecar.

**Unverified by a human, and this is the real gap** — a lot landed fast: smart search
phrasing, offline launch in airplane mode, Spotlight results, SharePlay on a FaceTime
call, and CarPlay (no car yet, though the entitlement is granted and signing works).

## Things learned the expensive way

Each of these cost real time or shipped a bug. They are in the repos' own comments
too, but they are the ones worth carrying across.

- **A row that changed without an op silently never syncs.** Every syncable write goes
  through one method that writes the row and its op in a single transaction. Making
  them inseparable is cheaper than any reconciliation.
- **Clock skew: disbelieve a timestamp only when it is ahead of *both* the server and
  this device's own clock.** Testing against the server alone cannot tell a fast
  client from a slow server, and a NAS without an RTC is a slow server — at which
  point every device rejects every other device's edits, permanently and silently.
- **The play/skip definition must be identical everywhere.** Completed, or
  `min(50% of duration, 4 minutes)`. Two implementations disagreed by five cases and
  both passed their own tests; a smart playlist then shows different songs than the
  play count beside them, and nobody ever tracks that down.
- **Fractional indices must increment when appending, not bisect.** Bisecting reached
  167-character keys over a thousand appends; incrementing reaches 33.
- **Upload a cover before pushing the op that names it**, or other devices hold a hash
  they can never fetch and nothing notices — the row is perfectly valid.
- **`UIGraphicsImageRenderer` defaults to the screen scale**, so "1000 points" became
  3000 pixels and a 1.5 MB cover where 183 KB was intended. It survived because
  nothing failed; it merely cost eight times the bandwidth forever.
- **Swift traps on `x?.field = max(x?.field ?? 0, …)`** — the assignment holds an
  exclusive access while the right-hand side reads the same property. Deterministic,
  not a race. It crashed every song.
- **Three separate faults were diagnosed only after reading the server's actual
  words.** Each time the client had the evidence and discarded it on the way to a
  summary. Do not summarise an error before it has been useful.
- **When a batch operation fails as a whole, bisect to find the offender** rather than
  retrying it forever — and blame nothing if the fault stops reproducing alone.

## Environment

- Phone: `Phone`, `11111111-2222-4333-8444-555555555555`. Simulator: iPhone 17,
  `00000000-0000-4000-8000-000000000000`.
- Jellyfin 10.11.11, on a private host. The hostname is deliberately **not** written
  down here — it is in three tracked files in `Virel0/aoide`, which is why that
  repository stays private. Keep this one free of it so it stays publishable.
- iOS DEBUG launch arguments, for looking at things without signing in:
  `-AoideUIHarness` (component layouts), `-AoideTabPreview` (the tab bar against an
  unresolvable host), `-AoidePlaybackProbe` (plays a synthesised tone through the real
  engine and reporters — this is what found the playback crash).
- Passwords are never typed by the assistant, so anything needing a login is a human
  step and everything downstream is verified instead.

## Starting here

`pnpm install` then `pnpm dev`. Electron 41, React 19, TypeScript, Zustand, axios.
Feishin's Jellyfin client is in `src/renderer/api/jellyfin/` and already holds the
credentials the sidecar needs — reuse them rather than configuring a second server.

Keep Aoide code in `src/renderer/aoide/**`. Upstream is alive and pushed to today; the
entire value of this fork is being able to keep merging it, and every line changed in
a shared file is a line that conflicts.

Build order and the reasoning behind each step: `docs/aoide-integration.md`. The first
two — the sidecar client and a local store with an op log — are the bulk of the work.
Everything after that is screens.

## Installing it (Arch / CachyOS)

```
sudo pacman -Syu nodejs pnpm
cd packaging/arch && ./build.sh
```

**Use `./build.sh`, not `makepkg` directly.** makepkg puts `src/` and `pkg/` next to
the PKGBUILD, which here means inside the checkout — and electron-builder walks the
whole project root looking for node modules, so it descends into a `pkg/` written
under fakeroot and dies with a bare `EACCES: permission denied, scandir`. The script
sets `BUILDDIR` and `PKGDEST` to move both out of the tree. The PKGBUILD refuses to
build if it detects the broken layout, rather than failing ten minutes in.

The first line is not redundant with `makepkg -s`. makepkg resolves dependencies
against **pacman's database only**, so a Node installed through nvm, `n`, or corepack
is invisible to it and it fails with "Could not resolve all dependencies". Both
packages are in `extra`.

If the build itself then fails somewhere inside vite or electron-builder, suspect the
Node version before suspecting the code. `extra/nodejs` tracks Current (26.x at the
time of writing) while this tree was built and verified on **24.15**. Swap to
`nodejs-lts-krypton` (24.x) — the LTS packages all declare `provides=(nodejs)`, so
the PKGBUILD needs no change.

A local package, not an AUR one — it builds from the checkout it sits in, because
this repository is private and there is nothing for makepkg to fetch. That is why it
uses `$startdir`, which a published AUR package must never do. Going to the AUR needs
a real `source=()` and a public repository; the hostname that used to block that has
been scrubbed from every commit, so the decision is now only whether to publish.

Things that were found by building it rather than by reasoning about it:

- **The executable was `aoide-desktop`, not `Aoide`.** electron-builder derives it
  from package.json `name`, not `productName`. `executableName: aoide` is now pinned
  in all three builder configs so it cannot drift, and the PKGBUILD still checks
  rather than assumes — a symlink pointing at nothing starts nothing.
- **`chrome-sandbox` must be setuid root** (`chmod 4755`) or Electron refuses to
  start, blaming the sandbox rather than the permissions.
- **`options=('!strip')`** — Electron ships prebuilt binaries and stripping breaks
  them.
- **Building rewrites a tracked file.** `afterAllArtifactBuild` runs
  `scripts/update-app-stream.mjs`, which rewrites the metainfo release list and
  stamps today's date. Every build leaves the tree dirty; that is the hook, not a
  mistake.

mpv is a hard dependency rather than an optdepend on purpose. The web backend plays
audio without it, but mpv is what gives gapless playback and the wider format
support, and the point of packaging this was that one install gets the good version.

## The rename, and why it was step zero

The target machine already has upstream Feishin installed, so this fork was given its
own identity before anything was built. Not cosmetic — four of these are collisions an
installed Feishin would actually lose or win:

| | was | now |
|---|---|---|
| appId / desktop id | `org.jeffvli.feishin` | `com.gabereglat.aoide.desktop` |
| product name | `Feishin` | `Aoide` |
| package name | `feishin` | `aoide-desktop` |
| MPRIS bus name | `Feishin` | `aoide` |
| URL scheme | `feishin://` | `aoide://` |
| update source | `jeffvli/feishin` | `Virel0/aoide-desktop` |

The update source is the dangerous one: left alone, the auto-updater and the in-app
release check would have offered upstream Feishin builds as updates *to this app*. The
alpha channel's S3 endpoint was blanked for the same reason. MPRIS is the one that
would have been merely baffling — two players claiming the same bus name means media
keys and `playerctl` hit whichever registered first.

Deliberately left alone: `media/feishin.icon` (artwork, cosmetic), the Discord
display-type enum value `'feishin'` (persisted in settings — renaming it silently
invalidates a stored preference), and the body of `README.md` (upstream's own
documentation, kept intact as the fork notice says).
