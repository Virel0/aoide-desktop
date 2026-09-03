# Handoff

Three pieces, three conversations. This one is the desktop client: forked, renamed,
packaged, and confirmed installed and running on the target machine — but it is still
Feishin. None of the Aoide half exists yet.

| | where | repo | state |
| --- | --- | --- | --- |
| **Aoide iOS** | `~/Jelly music` | `Virel0/aoide` (private) | shipped, on the phone |
| **Aoide sidecar** | *(other chat)* | `Virel0/aoide-sidecar` (public) | working, syncing |
| **Aoide desktop** | `~/aoide-desktop` | `Virel0/aoide-desktop` (private) | in daily use; sync, playlists, search, mixes, shared queue |

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
- **Two edits to one row inside the same millisecond are indistinguishable, and
  the second one vanishes.** Both carry the same `updated_at`, so every other
  device sees a tie, keeps what it has, and drops the newer write with no error.
  A delete issued straight after a create disappears exactly this way. Timestamps
  are now per-row monotonic — `max(now, thatRow.updated_at + 1)`. Scoped to the
  row, never to the device: a global monotonic clock runs ahead of real time
  during a bulk import (a thousand rows, a thousand milliseconds) and a device
  that believes it is in the future starts skew-correcting its own writes.
- **A payload is the row, so the column names are the wire.** iOS spells them
  camelCase; the design doc's SQL spells them snake_case; the desktop client was
  written from the doc and could not apply a single inbound playlist op. Nothing
  reported an incompatibility — the row simply failed `NOT NULL` on columns it could
  not find. Read the other client's schema, never the specification, for anything that
  travels.
- **SQLite has no booleans and Swift will not accept 0 for one.** `JSONDecoder` throws
  on a number where it wants `Bool`, so the phone quarantines the op — permanently,
  because rejected ops are never retried — while this side reports a successful push.
  Convert on the way out, and list the boolean columns explicitly rather than sniffing
  SQLite's advisory column types.
- **Build the payload by reading the row back, never from the caller's arguments.**
  Anything filled by a `DEFAULT` is otherwise missing from the wire while being
  present in the database, and the receiving client's non-optional field fails to
  decode.
- **Two sets that must agree will drift.** `deleted` is metadata on the phone, and the
  desktop had it in the merge's structural set but not in the stamper's, so it stopped
  merging `deleted` per field while still *emitting* a stamp for it. One exported
  definition now, used by both.
- **`cmd | tail` reports `tail`'s exit code, not `cmd`'s.** A pipeline exits with its
  last command, so piping a checker into `tail` for readability turns every failure
  into a pass. This has now silently reported success over a broken build twice: once
  on iOS with a test target that would not compile, once here with thirteen type
  errors in a test file. Capture the exit code directly, or `set -o pipefail`.

## Answered: skew correction can be switched on

An earlier note here asked the sidecar for a `receivedAt`. It has attached one to every
pulled op since 1.0.0.0 — the question was answered before it was asked. `createdAt` is
the writing device's clock, `receivedAt` the server's, stamped on arrival.

**Judge skew per batch, not per op.** Ops pushed together share a receipt time, so
comparing two ops inside one batch measures nothing.

Two other things from the sidecar's 1.7.0.0 contract that change client rules:

- **One rejection is no longer permanent.** Everywhere else a rejected op is
  quarantined forever; a playlist that "belongs to another user and is not shared with
  you for editing" can become valid again. It must be neither retried blindly nor
  silently dropped — this client models it as its own outcome so a caller cannot fall
  into the quarantine path by accident.
- **Retention is bounded by the lowest cursor among devices that pull.** A device that
  pushes but never pulls is invisible to that guard and its history can be pruned out
  from under it, so a sync always completes a pull even with nothing to push.

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
`pnpm test` runs vitest over `src/renderer/aoide/**` only — Feishin ships no tests, and
putting its renderer under a runner would mean standing up jsdom and Electron's preload
bridge for code that is not ours to verify.
Feishin's Jellyfin client is in `src/renderer/api/jellyfin/` and already holds the
credentials the sidecar needs — reuse them rather than configuring a second server.

Keep Aoide code in `src/renderer/aoide/**`. Upstream is alive and pushed to today; the
entire value of this fork is being able to keep merging it, and every line changed in
a shared file is a line that conflicts.

Build order and the reasoning behind each step: `docs/aoide-integration.md`. The first
two — the sidecar client and a local store with an op log — are the bulk of the work.
Everything after that is screens.

## What changed on 2026-09-03

Four things, four commits, all on `development`, none pushed.

- **Sync runs by itself.** Once when a signed-in server with an op log becomes
  usable, and again whenever the window regains focus or becomes visible, at
  most once a minute. It never toasts; a sidecar that is down is logged. After a
  run that applied remote ops, Feishin's own Jellyfin playlist list is
  invalidated, since the sidecar's export can create playlists on the server.
  `useAoideSync().sync()` now resolves to the state it set.
- **"Add to Aoide playlist" is in every menu** the Jellyfin one is in. It takes
  the sibling's `items` + `itemType` and resolves them to songs through Feishin's
  own lookups when a playlist is *chosen*, never when the menu opens. Past eight
  playlists it grows a search box.
- **One preference for which playlists the sidebar shows** — `both` (default,
  nothing changes for an existing install), `aoide`, `jellyfin`. General settings
  tab, its own Aoide section. The hidden kind keeps its route.
- **Covers repaired by name, conservatively.** Once per launch after the first
  successful sync, and from a "Repair covers" button. Exactly-one name match
  writes `artworkItemId` through a new `setArtwork` (op recorded, syncs to the
  phone); `sourceJellyfinId` is never touched, and that is tested from both
  ends. Until then the hero, card and sidebar draw the first track's album art.

Still open: the play/skip crossover, the Feishin-style playlist table, Discord.
The iOS half of the cover fix — `importFromServer` recording `sourceJellyfinId`
— is unchanged by this and still the real fix.

### Also on 2026-09-03: Spotify playlist import, both apps

Gabe asked for "someway for someone with a Spotify playlist to import their playlist
and see what is missing from the server". Research first (see the reasoning in
`src/shared/aoide/playlist-import.ts`): Spotify's Web API stopped returning the
contents of playlists a developer does not own in February 2026, and Extended Quota
Mode needs a registered business — so **no API key is asked for, and the OpenRouter
pattern does not apply.** Two routes remain and both are built:

- **A pasted link.** Spotify's *embed* page (`open.spotify.com/embed/playlist/{id}`)
  still ships the first **100** tracks in a `__NEXT_DATA__` script, no account needed.
  Title, comma-joined artists, duration. Undocumented, so the parser fails loudly
  (`pageChanged`) rather than returning an empty playlist.
- **A CSV export** (Exportify's headers, with aliases for other tools) carries the whole
  playlist plus album and ISRC.

**Matching is a written specification shared by both apps** — normalisation, noise
words, scores, thresholds — in `TrackMatcher.swift` (JellyfinKit) and
`src/shared/aoide/playlist-import.ts`, each checked against **the same table of cases**
(`ImportTests.swift`, `playlist-import.test.ts`). Change a row in one, change it in the
other. Desktop: `/aoide/import`, sidebar row "Import a playlist", main-process fetch in
`playlist-import.ts` with an injectable page loader. iOS: "Import from Spotify…" in the
Playlists screen's menu (`Aoide/Features/Import/`). Both save the found half as an Aoide
playlist and copy the missing half as text.

**Exportify, folded in as far as it can be.** It talks to Spotify through its own
registered application with a PKCE redirect pinned to exportify.net, and Spotify no
longer grants new applications what that one was granted — so it cannot be embedded as
a library or its client id borrowed. The desktop opens it in a window of its own
(`persist:aoide-exportify` partition, so the Spotify sign-in is remembered), catches the
CSV it saves via `will-download`, and feeds it straight into the import; the zip from
"export all" gets the ordinary save dialog. iOS links to it in Safari; the export lands
in Files and the sheet reads it from there. Exportify only lists the signed-in user's
own playlists and Liked Songs — Spotify's rule, not ours.

**The sidecar proposed `POST /aoide/match`** (server-side matching, one round trip).
Worth taking for long lists once it exists, *implemented to the same specification and
checked against the same table*; the clients then try it first and fall back to local
matching. Input is `ImportedTrack`: `title`, `artists[]`, optional `album`,
`durationMs`, `isrc` — the embed route carries no album or ISRC, so a content-key
exact match only ever applies to CSV imports and the fuzzy path is the main path.

### Also on 2026-09-03: the iOS side of the feedback list

All on `main`, pushed, installed on the phone (`f5acdaf`):

- **Secrets out of the tree** (`7cbc225`): Team ID and default server live in the
  gitignored `Config/Local.xcconfig`. History still holds them — the rewrite script is at
  `~/aoide-scrub-history.sh` on the Mac and **Gabe has to run it** before going public.
- **Streams that fail to load retry with backoff** instead of being dropped
  (`LoadRetryPolicy`); the current track buffers ten minutes ahead.
- **Library refreshes on return to foreground** if older than five minutes, in place.
- **Downloads screen** lists playlists → albums → loose songs (`DownloadedCollection`);
  local playlists can be downloaded whole.
- **Playlists screen preference**: both / mine / server (`aoide.playlistSurface`, the
  same three values as the desktop's `general.aoidePlaylistSurface`).
- **Gapless:** FLAC downloads are converted to Apple Lossless on the phone, one at a
  time, proven sample-exact by test. Streaming still plays FLAC and keeps the ~57 ms gap.

## The work order, agreed

In this order. Each is self-contained; nothing here is blocked on anything else.

### 1. Playlist covers  *(done, 2026-09-03)*

**Symptom:** every Aoide playlist draws a placeholder. **Cause, measured on the real
database rather than guessed:**

```
sqlite3 ~/.config/Aoide/aoide-curation.db \
  "SELECT name, imageHash IS NOT NULL, artworkItemId, sourceJellyfinId FROM playlists WHERE deleted=0;"
```

Every row is NULL for all three. The phone never recorded where those covers came from,
so no client has anything to draw. The desktop already reads the phone's precedence —
`imageHash`, then `artworkItemId`, then `sourceJellyfinId`, see `PlaylistArtwork.swift`
— and finds all three empty.

**The same missing `sourceJellyfinId` is why re-import produced duplicate playlists**
(the sidecar chat measured that independently). One cause, two symptoms.

Two pieces:

- **The repair, desktop — done.** `cover-repair.ts` matches a coverless playlist to a
  Jellyfin playlist **by name** and writes `artworkItemId` through `setArtwork`, which
  then syncs so the phone gets the cover too. Only when *exactly one* Jellyfin
  playlist carries that name, and recorded as **artwork**, never as
  `sourceJellyfinId` — a name match cannot prove provenance, and writing provenance on
  a guess would corrupt the key that deduping depends on. Runs once per launch after
  the first successful sync, and from the sync panel.
- **The real fix, iOS — already in place.** Checked on 2026-09-03:
  `LocalPlaylistStore.importFromServer` calls `store.importPlaylist(named:from:tracks:at:)`
  with the server playlist's id, which is `sourceJellyfinId`. The NULL rows came from an
  older build; the desktop repair covers them and new imports carry provenance.

### 2. The play/skip crossover above twenty minutes

**What it is.** A play is `min(half the track, 4 minutes)`. A skip is `a fifth of the
track`. Those were meant to be disjoint, and the Swift says so — but they cross at
**20 minutes**: past that, a fifth of the track exceeds four minutes, so five minutes of
a thirty-minute DJ set is *over* the play threshold and *under* the skip threshold at
once. `classify()` returns `countsAsPlay` **and** `skipped`.

**Why nobody has hit it.** The iOS boundary matrix stops at exactly 1,200,000 ms. Both
clients reproduce the behaviour identically, so nothing disagrees — it is wrong in the
same way everywhere, which is why it has never shown up as a sync bug.

**What it actually costs today:** an imported play event with no stored verdict gets
counted once as a play and once as a skip, inflating both figures for that track and
making its skip *rate* meaningless. Long mixes and DJ sets only.

**The decision to make** (needs iOS, desktop and sidecar to agree, because a smart
playlist and a play count that disagree is the exact failure the shared definition
exists to prevent): cap the skip threshold at something below the play ceiling — a
fifth of the duration **or four minutes, whichever is smaller** is the obvious
candidate, and keeps skips meaning "rejected it early" at every length. Then extend the
matrix past 1,200,000 on both clients so the boundary is actually exercised.

### 3. The Feishin-style playlist table

Asked for and repeatedly deferred. The detail view currently has Feishin's *shape* —
hero, covers, iOS radii — on a hand-written list. Porting to Feishin's item-table system
means feeding our rows through its column factories, list context and filter hooks.

**The thing not to lose:** the current view owns the drag-to-reorder that writes exactly
**one** row per move, via `positionBetween`. That single-row property is what makes
playlist order survive two devices reordering at once. A port that lets the table
renumber rows destroys it silently — the playlist still looks right on the device that
did it.

### 4. Discord Rich Presence still says "Feishin"

`FALLBACK_DISCORD_APPLICATION_ID` in `src/main/features/core/discord-rpc/index.ts` is
upstream's registered application, and the name Discord shows is that application's.
Only registering an Aoide application at discord.com/developers changes it — a human
step, then paste the id into Settings.

## Where this was left

Both repos are pushed as of `cee2765d` (desktop) and `44ade8e` (iOS). The four
commits of 2026-09-03 sit on `development` unpushed. 580 tests on the desktop,
typecheck and lint clean; iOS builds clean.

**Working and used:** sync against the sidecar, Aoide playlists with covers from
Jellyfin, track resolution for synced playlists, natural-language search over
OpenRouter, mixes on both apps, shared queue between devices.

### The one open bug  *(desktop half repaired 2026-09-03 — see "What changed" above)*

**Playlist covers are blank, and it is not a rendering fault.** Measured on the real
database:

```
sqlite3 ~/.config/Aoide/aoide-curation.db \
  "SELECT name, imageHash IS NOT NULL, artworkItemId, sourceJellyfinId FROM playlists WHERE deleted=0;"
```

Every row returns NULL for all three. The phone never recorded where those covers came
from, so there is nothing for any client to draw. The desktop reads the phone's own
precedence (`imageHash`, then `artworkItemId`, then `sourceJellyfinId` — see
`PlaylistArtwork.swift`) and finds all three empty.

**The same missing column explains the duplicate playlists the sidecar chat found on
re-import**, because `sourceJellyfinId` is what deduping matches on. One cause, two
symptoms.

The desktop repair is now in: a coverless playlist is matched to a Jellyfin playlist
**by name** and `artworkItemId` is written — which then syncs, so the phone gets the
cover too. Conservative only: exactly one Jellyfin playlist with that name, recorded as
*artwork* rather than as provenance, since a name match cannot prove where a playlist
came from. The real fix still belongs in the phone's import, which should record
`sourceJellyfinId` in the first place.

### Also open

- The Feishin-style playlist table. The detail view has Feishin's shape — hero, covers,
  iOS radii — on a custom list. Porting to Feishin's item-table system means feeding our
  data through its column factories and list context, and the current view owns the
  drag-to-reorder that writes exactly **one** row per move. A hasty port loses that.
- The play/skip thresholds cross above twenty minutes: five minutes of a thirty-minute
  set counts as a play *and* a skip. Present on both clients, and the iOS test matrix
  stops exactly at the boundary, so neither has ever exercised it. Needs one decision
  across iOS, desktop and the sidecar rather than a fix on one side.
- Discord Rich Presence still announces "Feishin" — the fallback is upstream's
  registered application id, and only registering an Aoide application changes it.

### Nothing is waiting on the sidecar

Mixes ride on `playlists.smartRules`, which the server stores opaquely and never parses.
The shared queue uses `GET /aoide/queue` and `queue_state`, both shipped in 1.7.0.0. The
one question worth asking them: does their playlist export set `artworkItemId` when it
adopts a Jellyfin playlist? That bears directly on the cover bug above.

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
