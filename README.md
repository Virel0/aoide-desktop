<img src="assets/icons/icon.png" alt="Aoide" align="right" height="64px" width="64px" />

# Aoide for Linux

A music player for your own Jellyfin server, and the desktop half of
[Aoide on iPhone](https://github.com/Virel0/aoide). Playlists, listening history
and taste live on your devices and sync between them through the
[Aoide sidecar](https://github.com/Virel0/aoide-sidecar), a small Jellyfin
plugin. A playlist made on the phone is on the desk; a song played at the desk
counts on the phone.

Aoide is a fork of [Feishin](https://github.com/jeffvli/feishin), GPL-3.0, and
owes it most of its bones.

## Install

**Arch, CachyOS and derivatives.** Add the repository once and Aoide upgrades
with the rest of your system:

```sh
sudo tee -a /etc/pacman.conf <<'EOF'

[aoide]
SigLevel = Optional TrustAll
Server = https://github.com/Virel0/aoide-desktop/releases/latest/download
EOF
sudo pacman -Syu aoide
```

Using fish, which has no heredocs:

```fish
printf '%s\n' '' '[aoide]' 'SigLevel = Optional TrustAll' 'Server = https://github.com/Virel0/aoide-desktop/releases/latest/download' | sudo tee -a /etc/pacman.conf
sudo pacman -Syu aoide
```

**Anywhere else.** Download `aoide.flatpak` from the
[latest release](https://github.com/Virel0/aoide-desktop/releases/latest):

```sh
flatpak install aoide.flatpak
```

See [packaging/flatpak](packaging/flatpak/README.md) for building it yourself
and for moving your settings across.

**From source**, for development: `pnpm install && pnpm dev`.

## What it does that Feishin does not

Everything here is Aoide's own, and most of it exists because the sidecar keeps
an honest record of what you actually listened to.

**Playlists that are yours.** Kept on the device and synced between them, with
folders, drag-to-reorder that survives two devices reordering at once, chosen
covers, and smart playlists whose rules re-run every time you open them. Two are
built in: *Rediscover Mix* and *Heavy Rotation*. Jellyfin's own playlists are
still there, and a preference decides which of the two kinds the sidebar shows.

**Listening history worth trusting.** A play is half the track or four minutes,
whichever comes first; a skip is under a fifth. Jellyfin counts a play the moment
audio starts, so a four-second skip counts there exactly as much as an album
side. Both apps use one definition, checked against one table of cases, so the
phone and the desk never disagree.

**Replay.** This month, this year or all time: plays, hours, the busiest day, and
the songs, artists and albums you actually finished.

**Mixes.** Describe a mood and get a queue. The model writes *rules*; the rules
pick the songs, so a mix can never contain a track your library does not have.
Naming a game, film or artist searches for it and takes the mood it implies.

**Taste controls.** *Not Interested* keeps a track out of mixes, stations,
shuffle and every smart playlist while leaving it playable. *Don't Count Plays*
keeps it out of the history, for the sleep playlist and the children's songs.

**Now Playing as a column.** Artwork, controls, lyrics and the queue beside the
page rather than under it, with the phone's typography. Toggle it off and
Feishin's bottom bar is still there.

**Resume in one tap.** Home opens on the last things you were in, and on a
"pick up" tile when your phone was playing more recently — same queue, same
position.

**Import from Spotify.** Paste a playlist link, or an Exportify CSV, and see what
your server has and what it lacks. Matching rules are shared with the phone and
the sidecar, checked against one table of cases.

**Silence trimming.** Where the sidecar has measured a file, only the sounding
part plays, so the seconds of nothing some recordings carry at either end are
skipped without a stall at the boundary.

## Requirements

- A Jellyfin server. Developed against 10.11.
- The [Aoide sidecar](https://github.com/Virel0/aoide-sidecar) plugin on it, for
  sync, taste flags, Spotify matching and silence measurement. Without it Aoide
  still plays music and keeps playlists locally.

## Packaging

| Where | What |
|---|---|
| [`packaging/arch`](packaging/arch) | Build and install from a checkout |
| [`packaging/arch/release`](packaging/arch/release) | The package CI builds for a tag, and the pacman repository |
| [`packaging/aur`](packaging/aur) | An AUR package, for whenever AUR registration reopens |
| [`packaging/flatpak`](packaging/flatpak) | The Flatpak |

Pushing a tag `v*` builds the Arch package and creates the release. The Flatpak
is attached by running the **Flatpak** workflow with that tag, because GitHub
will not start one workflow from a release another workflow's token created.

## Development

Built with [electron-vite](https://github.com/alex8088/electron-vite) on Node 23.

```sh
pnpm run dev          # development server
pnpm run build        # build for desktop
pnpm run typecheck    # types
pnpm run lint         # typecheck, eslint, stylelint
pnpm test             # the suite
```

Aoide's own code lives under `src/main/features/aoide`, `src/renderer/aoide` and
`src/shared/aoide`, in its own files wherever possible so an upstream merge has
little to reconcile. Rules that both apps must agree on — the play definition,
smart-playlist rules, import matching — live in `src/shared/aoide` and are
mirrored in the iOS app, each side checked against the same cases.

## FAQ

**A track will not play, or plays as a much larger download than it should.**
Everything decodes in Chromium, which does not handle ALAC, WavPack, DSD, APE or
WMA. Those transcode on the server instead, which needs transcoding enabled in
Jellyfin. Aoide used to decode them itself through mpv; that backend is gone.

**Which servers are supported?** Jellyfin. Feishin's Navidrome and OpenSubsonic
support is still in the code but is not what Aoide is built or tested against,
and the sync features need the Jellyfin sidecar.

**"The SUID sandbox helper binary was found, but is not configured correctly".**
The packaged builds handle this. Running an unpackaged build on a kernel with
unprivileged user namespaces disabled needs `chmod 4755` on `chrome-sandbox`.

**Custom themes.** Feishin's theme support is intact; drop a theme file in the
themes directory shown in Settings.

## Thanks

To [jeffvli](https://github.com/jeffvli) and Feishin's contributors, whose work
this is built on, and to the Jellyfin project.

## License

GPL-3.0, as Feishin is. Distributing a build obliges you to offer the source.
