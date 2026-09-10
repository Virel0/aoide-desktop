# Privacy Policy

**Aoide Desktop** — last updated 10 September 2026.

Aoide is a music player for a Jellyfin server you run yourself. There is no Aoide
service, no Aoide account and no Aoide server: nothing in this application sends
your data to its authors, and there is nowhere for it to be sent.

## What is stored, and where

Everything Aoide keeps is kept on your own computer, in the application's data
directory:

- your playlists, listening history, taste flags and settings, in a local SQLite
  database;
- the address of your server and your session token, so you stay signed in;
- your OpenRouter API key, if you set one, held in your operating system's
  credential store (Keychain on macOS, libsecret or kwallet on Linux, DPAPI on
  Windows) rather than in a file;
- cached artwork and cached measurements of your own files.

Deleting the application's data directory deletes all of it. Nothing is uploaded
as a backup.

## What leaves your computer

**Your Jellyfin server.** Aoide talks to the server you configure, using the
credentials you give it, to browse and play your library and to record what you
played. If you install the Aoide sidecar plugin, your playlists and listening
history sync between your devices *through your own server* — no third party is
involved, and the payloads are opaque to anyone but your own devices.

**Lyrics providers** (LRCLIB, NetEase, Genius, SimpMusic). When a track has no
lyrics stored in your own library, the song's title and artist are sent to these
services to look them up. This is on by default and can be turned off in
Settings → General → Lyrics.

**OpenRouter**, only if you set an API key and use Smart Search or Mixes. Your
search sentence and a list of genre names from your library are sent to the model
you choose. Aoide does not send your listening history or your files. Without a
key, the feature does nothing and nothing is sent.

**Discord**, only if you enable Rich Presence. While it is on, the title, artist
and album of what you are playing, and the artwork address for it, are sent to
Discord so your profile can display them. It is off by default, it can be turned
off at any time in Settings → Window, and Aoide asks Discord for nothing in
return.

**GitHub**, to check whether a newer version of Aoide has been released. This can
be turned off in Settings → Advanced.

That is the complete list. Aoide contains no analytics, no crash reporting, no
advertising and no tracking of any kind. An earlier version inherited a usage
tracker from the project Aoide is forked from; it was removed in full, including
the script, the setting and its permission in the application's content security
policy.

## Children

Aoide is a player for a library you already own. It collects nothing about
anybody, including children.

## Changes

This file lives in the application's public repository, so its history is the
record of any change to it:
<https://github.com/Virel0/aoide-desktop/blob/development/PRIVACY.md>

## Contact

Open an issue at <https://github.com/Virel0/aoide-desktop/issues>.
