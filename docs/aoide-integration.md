# Aoide on the desktop

This is a fork of [Feishin](https://github.com/jeffvli/feishin), which is already a
good Jellyfin client. What it does not have is the half of Aoide that does not live in
Jellyfin: local playlists, smart playlists, real play history, and the sync that keeps
those in step with the phone.

## Why a fork rather than a port

The iOS app is SwiftUI on AVFoundation. Neither exists on Linux, so a port would mean
rewriting the two largest parts and keeping the smallest. Feishin already solves
everything that is not Aoide-specific — playback, transcoding, library browsing, the
Jellyfin API, packaging for a dozen distributions — and has 9,000 stars' worth of
people finding its bugs.

Measured before choosing this: the Swift packages `JellyfinKit` and `CurationKit` both
build and pass their full test suites on Linux. They are portable. The reason they are
not being reused here is the language boundary, not portability — Feishin is
TypeScript, and a Swift library cannot be dropped into an Electron renderer without a
native bridge that would be more work than the client it replaces.

**The sidecar contract is HTTP and JSON, so this is a reimplementation against a
specification, not a port of anything.** The server is deliberately dumb: it relays
ops and interprets nothing. Merging, conflict resolution and smart-rule evaluation are
the client's job, in whatever language the client happens to be written in.

## Upstream

`upstream` points at jeffvli/feishin. It is actively developed, so:

```
git fetch upstream && git merge upstream/development
```

Keep Aoide code in files of its own wherever possible — `src/renderer/aoide/**` rather
than edits scattered through Feishin's own modules. Every line changed in a shared
file is a line that conflicts on the next merge, and the value of forking something
alive is entirely in being able to take its fixes.

## Licence

Feishin is **GPL-3.0**, so this fork is too. That is not a problem, but it is worth
being precise about:

- Using it yourself, however modified, carries no obligation at all.
- **Distributing a build** — including handing an AppImage to a friend — obliges you to
  offer the source under GPL-3.0. Making this repository public is the easy way to
  satisfy that, and is why it is worth keeping the history clean of anything private.
- It does **not** reach the iOS app or the sidecar. They are separate programs that
  talk to this one over HTTP; that is not linking, and GPL does not travel across it.

## What has to be built

Roughly in dependency order. Each is useful on its own.

### 1. The sidecar client

`POST /aoide/sync/push` and `GET /aoide/sync/pull?since=&limit=`, on the Jellyfin
host, with the same `MediaBrowser Token` header Feishin already sends. Feishin's
Jellyfin client is in `src/renderer/api/jellyfin/` and already holds the credentials —
reuse them rather than configuring a second server.

The loop, which is not negotiable:

1. Push every local op where `synced = 0`
2. Mark the returned `accepted` ids synced
3. Quarantine anything in `rejected` — it will never be accepted, so retrying is an
   infinite loop
4. Pull from the stored cursor, repeatedly, while `hasMore`
5. Apply each batch, **then** store that batch's cursor

Step 5's order matters: storing the cursor only after applying means an interrupted
sync replays rather than skips.

**Push returns a cursor too. Do not store it as the pull cursor.** It is the server's
head sequence, and ops from other devices may sit below it that this device has never
seen — storing it skips them permanently.

### 2. A local store with an op log

Every syncable write records the row *and* an op, in one transaction. A row that
changed without an op is a change that silently never leaves the device, and nothing
afterwards can detect that it happened.

Zustand's persisted stores are the wrong shape for this — they hold state, and what is
needed is state plus an append-only log with its own bookkeeping. `better-sqlite3` in
the main process is the closest thing to what the iOS app does, and it makes the smart
playlist evaluator a query rather than a loop over everything.

Tables, mirroring `docs/sync-design.md` in the aoide repo: `playlists`,
`playlist_items`, `folders`, `likes`, `play_events`, `queue_state`, plus `ops` and
`sync_state`. Entity names on the wire are plural snake_case and matched strictly.

### 3. Conflict resolution

Last-writer-wins on `updated_at`, with `origin_device` as a deterministic tiebreak.
Which side wins is arbitrary; that every device independently reaches the *same* answer
is not — two devices resolving one conflict differently diverge permanently and nothing
notices.

Per field for `playlists` and `folders`, via a `fieldUpdatedAt` map inside the payload;
per row for everything else. A row without the map falls back to its `updated_at`, so
this interoperates with anything that has not implemented it.

Clock skew: a timestamp is disbelieved only when it is ahead of **both** the server's
`receivedAt` and this device's own clock. Testing against the server alone cannot tell
a fast client from a slow server — and a NAS without a real-time clock is a slow
server, at which point every device rejects every other device's edits, permanently and
silently.

### 4. Playlist ordering

`position` is a fractional index — a sortable string, not an integer. With integers,
inserting at row 3 renumbers everything below it, so two devices inserting at once
produce conflicting updates and last-writer-wins drops one of the inserts. Fractional
means an insert writes exactly one row.

Appending must *increment* rather than bisect towards the top of the alphabet. Measured
in the Swift implementation: bisecting reached 167-character keys over a thousand
appends where incrementing reaches 33.

### 5. Play history

The reason this exists at all: Jellyfin increments its play count the moment playback
*starts*, so a four-second skip counts exactly as much as a full listen. Aoide records
its own events and defines a play as completed, or at least `min(50% of duration, 4
minutes)` — the scrobbling convention. A skip is not completed and under 20%.

**Use the same definition here.** If the desktop and the phone disagree, a smart
playlist saying "played 3+ times" shows different songs on each, and that is a bug
nobody ever tracks down.

### 6. Cover art

Bytes never go in the op log — payloads cap at 256 KB and every device replays the
whole log. The row carries `imageHash` (lowercase hex SHA-256) and `imageMime`; the
bytes move through `PUT/GET/HEAD /aoide/images/{sha256}`.

**Upload the blob before pushing the op that names it.** Push first and every other
device sees a hash it cannot fetch. Downscale before uploading — 5 MB is a ceiling, not
a target, and roughly 1000×1000 JPEG is plenty for a cover.

## The specification

`docs/sync-design.md` in the aoide repo is the contract both existing implementations
were written against, including an "As built" section recording where reality diverged
from the original design. Read it before writing the client rather than after.
