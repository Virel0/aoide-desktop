# Handoff

Three pieces, three conversations. This one is the desktop client, which does not
exist yet beyond a fork and a plan.

| | where | repo | state |
| --- | --- | --- | --- |
| **Aoide iOS** | `~/Jelly music` | `Virel0/aoide` (private) | shipped, on the phone |
| **Aoide sidecar** | *(other chat)* | `Virel0/aoide-sidecar` (public) | working, syncing |
| **Aoide desktop** | `~/aoide-desktop` | `Virel0/aoide-desktop` (private) | forked, nothing built |

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
- Server `<private host>`, Jellyfin 10.11.11. **This is why `Virel0/aoide`
  stays private** — the hostname is in three tracked files.
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
