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

- Phone: the paired iPhone (find it with `xcrun devicectl list devices`). Simulator: iPhone 17 Pro.
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

## What changed on 2026-09-04 (desktop)

Four commits on `development`, not pushed. 718 tests, typecheck and both lints clean.

- **Now Playing is a column beside the page** (`c61c5a31`). The phone's hierarchy on
  a wide screen: artwork with a wash behind it, title, artist in the accent, Feishin's
  own `CenterControls`, then Lyrics or Queue. It takes over the right-sidebar slot of
  the default layout — same `<aside>`, same resize handle, so the width the queue was
  dragged to is the width the column gets — behind `general.aoideNowPlayingColumn`
  (default **on**; a toggle in the general settings tab, its own Aoide section). Off,
  nothing about the bar or the full-screen player changes. Below 1100px it steps aside,
  through `window.matchMedia` on the one constant in `now-playing-column.ts`. The
  lyrics are fetched by Feishin's `lyricsQueries.songLyrics` and drawn here: active line
  primary at full opacity, every other line at `INACTIVE_LINE_OPACITY` (0.45), scrolled
  so the active line sits a third of the way down. Not built: an AirPlay/route picker
  and SharePlay — the desktop has neither to pick from.
- **Home opens on a resume grid** (`0d17266a`). Up to six tiles of the last things
  playback started *from* — album, Jellyfin playlist, Aoide playlist, mix, station —
  recorded by one line in each of those pages' play handlers (`use-recent-contexts.ts`
  exports a `remember*` per kind). Per server, one entry per kind+id, 24 kept, in a
  persisted Zustand store of its own (`aoide-recent-contexts`). Artwork is rebuilt from
  the item id at draw time, never stored. Another device's queue is the first tile when
  it played more recently, through `queue/pick-up.ts`, which the sync panel now calls
  too. A mix tile reopens the mix page with the description filled in rather than
  spending a model request unasked. Nothing to show renders nothing.

**Things worth knowing:** `Handoff` now carries `receivedAt`, this device's clock when
`ageSeconds` was measured — compare against that, not `Date.now()` at render. The React
compiler's lint refuses `Date.now()` in render outright, which is how that came about.
There is one radio-count setting (`useArtistRadioCount`) and the album header uses it
for album radio too; the grid does the same.

- **The built-in playlists are made here too** (`ad0ad459`). "Rediscover Mix" and
  "Heavy Rotation" under `builtin:rediscover` and `builtin:heavy-rotation`, the same
  ids and rules the phone pins (`src/shared/aoide/built-in-playlists.ts`), so
  whichever device runs first makes the row and the other merges into it.
  `Playlists.ensureBuiltIns()` creates a built-in only when **no row with that id has
  ever existed** — `rowExists` reads the row deleted or not — so one that was removed
  stays removed on every device rather than returning each launch. Both writes go
  through `create` and `setSmartRules`, so they are ops and they sync. Main runs it
  once in the `app.whenReady()` chain right after the store opens; the store is one per
  machine, not per account, so nothing about the user has to be known first, and the
  renderer never has to ask — though `aoide:playlists-ensure-built-ins` is published
  in case a screen ever does.
- **Replay** (`56fac6a2`) at `/aoide/replay`, sidebar row "Replay". This month / this
  year / all time: plays, hours, songs, artists as tiles, busiest day, top songs
  (playable, in rank order), top artists, top albums. `PlayHistory.recap(from, to)` in
  the main process does all the counting, with `countsAsPlaySql` and nothing else, over
  a half-open window on `startedAt`. Artist and album come from the local `tracks`
  cache; a play whose track is not cached counts in `totalPlays` and `topTracks` and
  is reported as `unattributedPlays` — said on the page, never hidden. Albums are
  grouped on `COALESCE(albumArtist, artist)` so a compilation is one album. The
  renderer decides only where a period starts (`replay-period.ts`, local calendar);
  `to` is taken inside the `queryFn`. Not verified in the running app at the time; the
  desktop now records its own listening (next entry), so the page fills from the first
  track played at the desk rather than waiting for a sync.

### Also on 2026-09-04: the desktop records what it plays

Two commits on `development` (the feature, then this note), not pushed. 778 tests, typecheck and both lints clean.

Until this, the store only ever *received* `play_events` — from the phone, through
`applyRemote`. Nothing recorded a listen at the desk, so every smart playlist, both
built-in mixes and Replay described the phone's listening and none of the desktop's.
Now the desktop does what the phone's `CurationRecorder` does, on the same row shape:

- **Main.** `PlayHistory.beginPlay` opens the row the moment a track starts —
  `msPlayed: 0`, `endedAt: null`, no outcome, `contentKey` from `contentKeyFor` — and
  `finishPlay` closes it with what was heard. Both go through `store.record`, so each
  is a row *and* an op; the finish is an **amendment of the same id**, which the
  phone applies over its open copy through `isMoreFinished`. `completed`/`skipped`
  come from `classify` in `play-definition.ts` and nowhere else; the finish also
  carries a `source` so the answer given at the beginning can be improved. Finishing
  twice is a no-op (`already`); an id never opened is ignored (`unknown`);
  `msPlayed` is floored at zero and made an integer. The IPC handler
  (`aoide:history-begin-play`) caches the track first, because the SQL judges the
  threshold arm against the cache's duration and Replay files plays by the cache's
  artist and album — a play of an uncached track is honest but unattributed.
- **Renderer.** `AoidePlayRecorderEffect` (mounted in `AppEffects`, only when
  `isAoideAvailable()`) forwards Feishin's own player events — `usePlayerEvents`,
  the same progress samples the scrobbler measures from, no timer of its own — into
  the pure state machine in `history/play-recorder.ts`, and its calls out over the
  bridge. A listen begins when a track is current *and* playing (a queue restored at
  launch arrives paused and opens nothing); it ends on the next track, on Stop, on
  the queue emptying, on `beforeunload`, and on unmount. Listening is the sum of
  forward steps of at most `MAX_LISTEN_GAP_SEC` between samples while playing —
  seeks, stalls and paused samples count nothing but move the baseline. A jump back
  to the first five seconds from past ten is a restart and a new listen, which is
  what keeps Repeat One from being one play that outgrew its track. The event id
  comes back asynchronously; the effect keys begins by a token and a finish waits
  for its begin.
- **Source.** `unknown` unless a page said what it started playback from — the
  same `remember*` calls that feed the resume grid, now also carrying `smart` for an
  Aoide playlist. Because pages that hold their songs queue first and announce
  second, an announcement within `SOURCE_TOLD_AFTER_MS` of a begin names that
  listen (at its finish); because the album page announces, fetches, then queues,
  an announcement within `SOURCE_TOLD_BEFORE_MS` before a queue replacement is that
  queue's. Either way it is claimed once. Kinds map to the phone's names: album →
  `album`, playlists → `playlist` (smart ones → `smart`), mix → `smart`, station →
  `unknown`.

**Verified by test, and by breaking it.** Every guarantee above has a test and was
mutation-checked — the rule broken in source, the test seen to fail, the file
restored from a pristine copy and `diff -q`'d. Main (`play-history.test.ts`): the
idempotent finish, the verdict from `classify` (both flags), the integer floor, the
unknown id, the kept/amended source, the content key — seven mutations, seven
caught. Renderer (`play-recorder.test.ts`, 41 cases): paused ticks, the restart
boundary, the gap boundary, duplicate track changes, begin-while-paused, the
fractional millisecond, both source windows, stop, queue replacement, and the
finish-before-begin order — eleven mutations, eleven caught. `wiring.test.ts` pins
the mount, the pure-module wiring, `beforeunload`, the cache-before-begin order in
the handler, and that nothing under `src/renderer/aoide` or `src/main/features/aoide`
imports `play-definition`, calls `classify`, or carries a `240`/`4 * 60` literal.
**Not verified in the running app** — nothing here was run against a real player;
the first thing to check is that Replay shows a play after one track at the desk,
and that the phone shows the same row after a sync.

### Also on 2026-09-04: taste flags, matching the phone's

Three commits on `development`, not pushed. 826 tests (from 778), typecheck and both
lints clean.

Two flags per track, synced like everything else, on the phone's `trackFlags` row —
`track_flags` on the wire and as the local table (schema v2). **`notInterested`** keeps
a track out of mixes and stations; it stays playable and stays in ordinary playlists.
**`dontCount`** opens no play event; history already recorded stays, including plays
another device recorded before it saw the flag, because evaluation reads the flag and
never assumes the events do not exist.

- **Store** (`track-flags.ts`). `setNotInterested` / `setDontCount` / `clear` through
  `store.record`, so each is a row and an op. The row is minted on first write; both
  flags off is recorded as a **delete** rather than an empty row; a flag set again reuses
  the deleted row's id (the read ignores `deleted`), so the phone sees one row change
  rather than a delete and a stranger. Merged **per field** like a playlist
  (`PER_FIELD_ENTITIES`), then deduped by `jellyfinId` like a like: two devices that each
  minted a row for one track keep the newer `(updatedAt, originDevice)` and hard-delete
  the other (`writeDeduped`, the phone's `mergeTrackFlags`). That dedupe now covers
  `likes` too — its unique index on `jellyfinId` had nothing keeping a second row from a
  constraint failure. Found on the way: `restampChangedFields` compared a boolean the
  caller wrote against the 0/1 SQLite read back and stamped it as an edit, which would
  have restamped both flags on every write of either; it now compares as stored.
- **Where the flags are read.** `Mix.narrow` drops hidden ids before any rule or limit
  sees them. **On the desktop that is the only place smart rules are evaluated** — smart
  playlists themselves are not evaluated here (the detail screen lists items, and a smart
  playlist has none), so `narrow` is the one exclusion in main. In the renderer the
  resume grid's station is Jellyfin's instant mix filtered through
  `aoide:flags-not-interested-among` (`taste/not-interested.ts`, one call for the list);
  Feishin's own shuffle and track radio are upstream and untouched. `PlayHistory.beginPlay`
  returns `null` for a "don't count" track and the recorder effect finishes nothing for
  it.
- **Push gate.** The sidecar's `/aoide/sync/status` lists `acceptedEntities` (and
  `pluginVersion`). The engine reads it once per sync, before the log, and asks the store
  to leave out every entity in `ENTITIES_NEEDING_SERVER_SUPPORT` (`sync-types.ts`; only
  `track_flags`) that is not listed — **in the SQL**, not after the LIMIT, so a log whose
  oldest rows are all held still fills the page. No status, or no list, holds them all;
  everything older than the advertisement goes as it always did. Held ops are neither
  pushed nor quarantined and are reported as `SyncResult.held`. `SyncStore.pendingOps`
  gained an optional `holding: string[]`; `sync-bridge.test.ts` pins that the bridge
  forwards it.
- **UI.** `TasteFlagActions` — "Not Interested" ↔ "Offer This Again", "Don't Count
  Plays" ↔ "Count Plays" — beside "Add to Aoide playlist" in the song, playlist-song and
  queue menus; one song at a time, disabled over a selection. Setting a flag sends the
  whole `TrackInput`: main caches the track and computes the content key, so the
  settings list can name it. "Hidden from mixes" in the general tab's Aoide section lists
  every flagged track (title/artist from the cache, or the id when the phone flagged
  something this device never cached) with which flags and a Clear that takes both off in
  one op. Strings under `aoide.taste.*` and `aoide.settings.hiddenFromMixes*`.

**Verified by test, and by breaking it.** Store (`track-flags.test.ts`, 23 cases): empty
row deleted, id reused, dedupe present, dedupe direction, per-field merge, mix exclusion,
`beginPlay` gate, the boolean restamp, booleans on the wire, the hard delete of the twin —
ten mutations, ten caught. Push gate (`sync-engine.test.ts` + store + bridge): hold
removed, status failure holding nothing, missing list holding nothing, status asked after
the log, store ignoring `holding`, held op quarantined, preload dropping the argument —
seven, seven caught. UI (`wiring.test.ts` + `not-interested.test.ts`): each mount, the
station filter, the pure filter, the undo wording, the flag check before `record`, the
cache in the handler — seven, seven caught. **Not verified in the running app**: the first
things to check are that the menu shows the undo wording after a flag, that a flagged
track shows in Settings after a sync from the phone, and that the sync panel reports
nothing quarantined against a sidecar that does not list `track_flags` yet.

### Also on 2026-09-04: a mix can name things, and a name implies a mood

One commit on `development` (`e900a970`), not pushed. 869 tests (from 826), typecheck
and both lints clean. The phone's two mix additions, matched here:

- **Names.** The model may return `names` — artists, albums, bands, games, films,
  shows the description named, spelled as written (`parseRules`, tolerant: a reply
  without the field is still valid; a reply whose rules were refused but which named
  something goes ahead on the names). Each name is searched the way the search page
  searches (`api.controller.search`: songs, albums, album artists), then every song of
  each album (`getSongList` by `albumIds`) and the songs of each artist (`artistIds`),
  fifty per lookup. Those ids go **first**, before the rule candidates, and are put
  first again after `Mix.narrow`, which sorts by last played. Beside a name, "all of
  nothing" no longer fetches the whole library (`wantsRuleCandidates`). Names are not
  saved with a mix: a smart playlist has no rule for "the library's search for X".
- **The mood a name implies.** The prompt (`buildMixPrompt`, the phone's words) says a
  war game or action film implies driving genres, a study session or building game calm
  ones, that someone naming a game wants music to play it to and not only its
  soundtrack, and to prefer two or three genres. The model's genres are matched to the
  library's by whole word either way, lower-cased, punctuation ignored (`matchGenres`):
  "rock" is "Rock", "Hard Rock", "Alternative Rock" and not "Rockabilly"; "soundtrack"
  is "Video Game Soundtrack" — the same rule as `MixComposer.libraryGenres`. **Genres
  are ORed** on the desktop: Jellyfin's `GenreIds` is a comma list answered with a
  track in any of them.
- **What was understood.** Under the input after a build: "Looked for: Helldivers 2 ·
  Rock, Metal, Electronic · not played in 6 months · 40 tracks" (`describePlan`). An
  empty mix says "Nothing in your library mentions X, Y." when names missed, or the old
  "Nothing in your library matched."; a mix that found the rest still names the misses.

All rules live in `mix/mix-plan.ts` and `mix/name-search.ts` (the latter behind a
`LibrarySearch` interface, so the collecting is tested without Feishin's controller);
`use-mix.ts` wires them. Eleven mutations, eleven caught. **Not verified in the running
app**: the first thing to check is a mix for a game the library has no soundtrack for,
which should come back non-empty on genres alone, with the line under the input saying
which.

### Also on 2026-09-04: sound bounds from the sidecar (silence trimming)

One commit on `development`, not pushed. 935 tests (from 869), typecheck and both lints
clean. The spec is `docs/sound-bounds.md` in the iOS repo. **The sidecar endpoint does
not exist yet**; everything here is built to be correct against a sidecar that answers
404 (no bounds for anyone, never a toast, left alone for ten minutes, then asked again)
and against one that answers `pending` (play whole this time, ask again after a minute).

- **Transport.** `SidecarClient.soundBounds(ids)` — `GET /aoide/sound-bounds?ids=…`,
  chunked at 200, a 404 ends the call at once with `absent: true`, any other failure
  throws, a row that is not two finite numbers is left out (the track then reads as
  unknown and is asked about again).
- **The plan** (`src/shared/aoide/trim-plan.ts`, shared so main can read it):
  `trimFor(bounds, durationMs) → { startSec, endSec | null } | null` — under 300 ms at
  either end is not worth a seek (the phone's rule, per end); an end past the track's
  length is a file replaced since it was measured and is refused; `shouldAdvance` is
  `>=`; `mpvFileOptions` spells the plan as `start=`/`end=` strings.
- **Cache** (`playback/sound-bounds-cache.ts`, pure; `sound-bounds-store.ts` around it):
  unknown → ask; in flight → wait 30 s before presuming lost; `pending` → re-ask after
  60 s; bounds or `null` → kept for the session; an id the server named in neither list
  → "nothing to trim", since nothing is coming. `useSoundBounds(trackId)` answers
  `undefined` until known and always `undefined` with the setting off — **the setting
  gates every consumer through that one hook**.
- **Web player.** `useTrimPlayers` over Feishin's two `<audio>` slots, fed from the same
  progress samples it scrobbles from (two one-line calls in `web-player.tsx`). Per slot,
  `trim-tracker.ts` (pure) issues the seek once and the end once, and again after a
  restart (Repeat One's loop, or a drag back to the intro). A seek is only ever from
  *before* the sound — a track picked up in the middle, or one whose bounds arrived late,
  is left alone. **Ending early is done by seeking the element to its own end**, which
  fires the element's `ended`, which is what Feishin's `onEnded` is wired to — so
  `handleOnEndedPlayerN` runs unchanged (auto-next, the pause, the volume, the
  transition flag) and only the audible slot may do it. An element whose duration is not
  finite (some transcoded streams) cannot be ended this way and plays to its own end.
  Crossfade and gapless compute their handover from the file's duration, so a trimmed
  end arrives before either has started its transition; the jump is clean but not
  crossfaded.
- **mpv.** Per-file `start=` and `end=` on `loadfile`, which mpv keeps per playlist entry
  and applies when that entry begins — the right shape for Feishin's two-item queue,
  where the next track is appended long before it plays. **Verified against the manual,
  not against Feishin's own code, because Feishin never passes options:** since mpv
  0.38.0 the third positional argument of `loadfile` is an insertion index and the
  options are fourth, with `-1` in the index slot (DOCS/man/input.rst). node-mpv
  2.0.0-beta.3's own `load(file, mode, options)` sends the options third — wrong on every
  current mpv — so `main/features/aoide/mpv-trim.ts` reads `mpv-version` once per
  instance and sends `command('loadfile', [url, mode, -1, options])` (or the old order
  below 0.38) through the wrapper's `command()`. Without a plan it is Feishin's own
  `load()`. All four loads in `core/player/index.ts` go through `loadWithTrim`; the
  renderer effect (`aoide-trim-effect.tsx`, mounted in `AppEffects`) tells main the plans
  for the current and next track by Jellyfin id over `aoide:trim-remember`, and main
  finds them by the id in the stream URL's path. **A plan that arrives after the load is
  a plan for next time**: the first track of a fresh session, and the one after it,
  tend to play whole once; the effect also asks ahead for the next fifty of the queue,
  so every later track is told before it is appended. Turning the setting off sends
  `aoide:trim-forget`.
- **Setting.** `general.aoideTrimSilence`, default on, its own section in the general
  tab with a footer saying where the numbers come from (`aoide.settings.trimSilence*`).

Nineteen mutations, nineteen caught (plan, tracker, cache, client, mpv helper, and the
wiring: a dropped slot, a bypassed load, an ignored setting, an inactive slot ending a
track). **Not verified in the running app, and cannot be until the sidecar ships the
endpoint.** When it does: (1) `curl -H 'Authorization: MediaBrowser Token="…"'
"$SERVER/aoide/sound-bounds?ids=<id>"` should answer the spec's shape; (2) play a track
with a long lead-in on the web player and watch the seek bar start past it and the next
track begin before the old one's tail; (3) the same on mpv — the seek bar starts past
the lead-in on the *second* track of a queue, and `mpv --msg-level=all=v` shows
`start=`/`end=` in the loadfile; (4) turn the setting off and confirm the next track
plays whole; (5) against a sidecar without the endpoint, nothing changes and nothing
toasts. If the mpv `loadfile` errors on an old mpv, the version read is the place to
look.

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
