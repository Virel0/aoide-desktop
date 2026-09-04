import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { INACTIVE_LINE_OPACITY } from './now-playing/now-playing-column';
import { syncOutcome } from './sync/sync-report';
import { FOCUS_SYNC_MIN_INTERVAL_MS } from './sync/sync-schedule';

/**
 * Guards over the component *source*, because these components cannot be
 * rendered here.
 *
 * The test runner is `environment: 'node'` on purpose: rendering Feishin's
 * renderer would mean standing up jsdom, the preload bridge and i18n for code
 * that is not ours to verify. Every rule worth testing therefore lives in a
 * plain module — `playlist-playback.ts`, `sync-report.ts` — and the `.tsx` files
 * are markup over their results.
 *
 * That leaves exactly one thing unguarded: whether the markup calls the right
 * function at all. It is not a hypothetical gap. The playlist screen shipped
 * calling `addToQueueByFetch(..., LibraryItem.SONG, ...)`, which Feishin's
 * `fetchSongsByItemType` has no branch for — so it returned an empty array and
 * `Play.NOW` replaced the queue with nothing. It compiled, it typechecked, and
 * it silently destroyed whatever was playing.
 *
 * Reading source text is a poor test and this is the failure that justifies it:
 * cheap, and aimed at a specific regression that has already happened once.
 * **It proves the call is written, never that it works.** The moment these
 * components can be rendered, replace this file with tests that render them.
 */

const sourceOf = (relative: string): string =>
    readFileSync(join(import.meta.dirname, relative), 'utf8');

describe('the playlist screen queues songs it already holds', () => {
    const source = sourceOf('playlists/aoide-playlist-detail.tsx');

    it('calls addToQueueByData', () => {
        expect(source).toContain('addToQueueByData');
    });

    // The exact defect. `fetchSongsByItemType` switches on ALBUM, ALBUM_ARTIST,
    // ARTIST, FOLDER, GENRE and PLAYLIST, then returns an empty `songs`.
    it('never reaches for addToQueueByFetch, which has no branch for songs', () => {
        // The call, not the name: the file names it in a comment explaining why
        // it is the wrong one, and that comment is worth keeping.
        expect(source).not.toMatch(/\baddToQueueByFetch\s*\(/);
    });

    it('names a starting song rather than slicing the queue short', () => {
        // Slicing from the clicked row leaves Previous unable to reach track one.
        expect(source).toContain('playSongId');
    });
});

describe('the sync panel reports what actually happened', () => {
    const source = sourceOf('sync/aoide-sync-panel.tsx');

    it('decides its status line from syncOutcome, not from finishedAt alone', () => {
        expect(source).toContain('syncOutcome');
    });

    it('renders the server’s own reason under each headline', () => {
        // Quarantine destroys the user's edit. A bare count does not tell them
        // why. Both halves are asserted — the guard that decides whether to show
        // it, and the expression that actually emits the text — because
        // mentioning `entry.detail` in a condition while rendering nothing was
        // the exact shape this has to rule out.
        expect(source).toMatch(/\{entry\.detail\s*&&/);
        expect(source).toMatch(/\{entry\.detail\}/);
    });

    it('renders a survivable failure as a warning rather than as an error', () => {
        expect(source).toContain('state.warning');
    });
});

describe('syncOutcome', () => {
    const state = (over: Record<string, unknown> = {}) =>
        ({ finishedAt: 1, phase: 'success', ...over }) as never;

    it('calls a completed run synced', () => {
        expect(syncOutcome(state({ result: {} }))).toBe('synced');
    });

    // The engine sets `result` on every run it completes, including one where
    // the push and the pull both failed and nothing moved.
    it('refuses to call a failed run synced, even though it has a result', () => {
        expect(syncOutcome(state({ phase: 'error', result: {} }))).toBe('failed');
    });

    it('distinguishes a reachability check from a sync', () => {
        expect(syncOutcome(state({ status: {} }))).toBe('checked');
    });

    it('says nothing at all before the first run', () => {
        expect(syncOutcome(state({ finishedAt: undefined, phase: 'idle' }))).toBe('idle');
    });
});

describe('the sign-in form', () => {
    const source = readFileSync(
        join(import.meta.dirname, '../../features/servers/components/add-server-form.tsx'),
        'utf8',
    );

    // Aoide is built around one server: the sidecar is a Jellyfin plugin and
    // authenticates with a Jellyfin token, so a Navidrome sign-in would succeed
    // and lead to an app whose Aoide half cannot work at all.
    it('offers Jellyfin and nothing else', () => {
        expect(source).toContain(
            'OFFERED_SERVER_TYPES: readonly ServerType[] = [ServerType.JELLYFIN]',
        );
    });

    it('does not default to a type it no longer offers', () => {
        expect(source).not.toMatch(/\?\?\s*ServerType\.NAVIDROME/);
    });
});

describe('the custom font protocol', () => {
    // Main registers `aoide:`; the renderer built `feishin:` URLs, so a custom
    // font fetched nothing. Renaming a scheme in one process and not the other
    // fails silently — the font simply never arrives.
    it('asks for the scheme the main process registers', () => {
        const renderer = readFileSync(
            join(import.meta.dirname, '../../themes/use-app-theme.ts'),
            'utf8',
        );
        const main = readFileSync(join(import.meta.dirname, '../../../main/index.ts'), 'utf8');

        expect(renderer).toContain('url("aoide:');
        expect(renderer).not.toContain('feishin:');
        expect(main).toContain("protocol.handle('aoide'");
    });
});

describe('the OpenRouter key field', () => {
    const source = readFileSync(
        join(import.meta.dirname, 'settings/smart-search-settings.tsx'),
        'utf8',
    );

    it('exists somewhere a person can find it', () => {
        const generalTab = readFileSync(
            join(import.meta.dirname, '../../features/settings/components/general/general-tab.tsx'),
            'utf8',
        );

        expect(generalTab).toContain('SmartSearchSettings');
    });

    // There is no channel that returns a key, so the field cannot be prefilled
    // even by accident — but it must also not try, and it must not echo what was
    // typed back after saving.
    it('never asks for the key back', () => {
        expect(source).not.toMatch(/getKey|smart-search-get-key/);
        expect(source).toContain('isConfigured');
        expect(source).toContain('type="password"');
    });

    it('clears the field after saving rather than holding the key in the page', () => {
        expect(source).toMatch(/setKey\(''\)/);
    });

    it('says so when there is no keyring, instead of failing quietly', () => {
        expect(source).toContain('keyNotEncrypted');
    });
});

describe('synced playlists get their track details', () => {
    // The tracks cache is per-device and never synced, so a playlist from the
    // phone arrives as a list of ids reading "Track not known to this device".
    it('resolves unknown tracks on the detail screen', () => {
        const detail = sourceOf('playlists/aoide-playlist-detail.tsx');
        expect(detail).toContain('useResolveUnknownTracks');
    });

    it('writes what it learns back to the store', () => {
        const hook = sourceOf('playlists/use-resolve-unknown-tracks.ts');
        expect(hook).toContain('cacheTracks');
        // Asking again forever for a track Jellyfin cannot resolve is the
        // failure mode; the id is marked before the lookup, not after it.
        expect(hook).toMatch(/attempted\.current\.add\(id\)/);
    });
});

describe('the search screen', () => {
    const source = sourceOf('search/aoide-search.tsx');
    const hook = sourceOf('search/use-smart-search.ts');

    // Reachable from the top left rather than from the Aoide section — that is
    // where people look for search, and the separate entry is what made the
    // feature invisible in the first place. The route guard below is what pins
    // it; this only records that the duplicate entry is gone on purpose.
    it('does not keep a second entry in the Aoide sidebar', () => {
        expect(sourceOf('sidebar/aoide-sidebar-list.tsx')).not.toContain('AOIDE_SEARCH');
    });

    // Every translation is a paid request. A search box that asked a hosted
    // model per character would cost real money to type a sentence into.
    it('never translates on a keystroke', () => {
        expect(source).not.toMatch(/onChange=\{[^}]*interpret/);
        expect(source).toContain('onClick={interpret}');
    });

    it('searches plainly without asking a model at all', () => {
        // Enter runs the ordinary search; interpretation is the extra step.
        expect(source).toMatch(/if \(event\.key === 'Enter'\) search\(\)/);
    });

    // A wrong reading is obvious when shown and invisible when assumed.
    it('shows what the phrase was understood to mean', () => {
        expect(source).toContain('aoide.search.understood');
        expect(source).toContain('smart.clear');
    });

    it('sends genre names to the model and ids to the server', () => {
        expect(source).toContain('genreNames');
        expect(source).toContain('genreIdsByName');
    });

    // Shown always, disabled when it cannot be used, and saying which. Hidden
    // was indistinguishable from broken: nothing on screen said the feature
    // existed or what it wanted.
    it('disables the description path rather than hiding it', () => {
        expect(source).toMatch(/disabled=\{!smart\.canInterpret \|\| !looksLikeAPhrase\(text\)/);
        expect(source).toContain('aoide.search.needsKey');
        expect(source).toContain('aoide.search.needsPhrase');
        expect(hook).toContain('looksLikeAPhrase');
    });
});

describe('the search people actually click', () => {
    // The Aoide search sat behind its own sidebar entry while every existing way
    // in — the sidebar's Search item, the command palette, the shortcut — went to
    // Feishin's. Typing "90s rock music" there searches for that literal string
    // and finds nothing, which reads as the AI being broken.
    //
    // The sidebar's route string is persisted in settings, so changing a default
    // reaches nobody who already has the app. Swapping what AppRoute.SEARCH
    // renders reaches everybody.
    it('renders the Aoide search at the route every entry point uses', () => {
        const router = readFileSync(
            join(import.meta.dirname, '../../router/app-router.tsx'),
            'utf8',
        );

        expect(router).toMatch(
            /element=\{<AoideSearchRoute \/>\}\s*\n\s*path=\{AppRoute\.SEARCH\}/,
        );
        expect(router).not.toContain('<SearchRoute />');
    });
});

describe('mixes', () => {
    const screen = sourceOf('mix/aoide-mix.tsx');
    const hook = sourceOf('mix/use-mix.ts');

    it('is reachable from the sidebar', () => {
        expect(sourceOf('sidebar/aoide-sidebar-list.tsx')).toContain('AOIDE_MIX');
    });

    // The measured principle: the model produces rules, the library and the
    // history select. A mix therefore cannot contain a track you do not own.
    it('asks for rules and never for songs', () => {
        expect(hook).toContain('mix.describe');
        expect(hook).toContain('mix.narrow');
        expect(hook).toContain('getSongList');
    });

    // Saved as rules, not as the tracks it happened to pick — a mix frozen to
    // today's songs stops being the thing that was described, and only the rules
    // are a format the phone already evaluates.
    it('saves the rules rather than the songs', () => {
        expect(screen).toContain('setSmartRules');
        expect(screen).toContain('JSON.stringify(mix.rules)');
    });

    it('says which rules it had to drop', () => {
        expect(screen).toContain('mix.rejected.map');
    });
});

describe('the shared queue', () => {
    const hook = sourceOf('queue/use-queue-handoff.ts');
    const panel = sourceOf('sync/aoide-sync-panel.tsx');

    // Only the server can say how recent a row is without trusting the clock of
    // the device that wrote it. A machine set wrong would otherwise claim to be
    // the most recent one forever and win every handover.
    it('judges freshness on the server’s clock, never the writer’s', () => {
        expect(hook).toContain('ageSeconds');
        expect(hook).toMatch(/transport\.queues\(\)/);
        // The local fallback derives an age rather than sorting on updatedAt as
        // though it were comparable across devices.
        expect(hook).not.toMatch(/sort\([^)]*updatedAt/);
    });

    it('offers a device that is not this one', () => {
        expect(hook).toContain('!entry.isCurrentDevice');
    });

    // Saving rarely is what costs: a handover offers whatever was last written,
    // so a queue saved only on quit is wrong exactly when somebody reaches for
    // their other machine.
    it('writes the queue as it changes, without a button to arm it', () => {
        expect(panel).toContain('useQueueBroadcast');
        expect(hook).toContain('lastSaved.current');
    });

    it('names the starting track rather than slicing the queue short', () => {
        expect(panel).toMatch(/addToQueueByData\(songs, Play\.NOW, start\?\.id\)/);
    });
});

describe('sync happens without a button', () => {
    const effect = sourceOf('sync/aoide-sync-on-launch-effect.tsx');

    // The button lives on a page most sessions never open. An effect that is
    // written but not mounted syncs exactly as often as no effect at all.
    it('is mounted with the app’s other effects', () => {
        const app = readFileSync(join(import.meta.dirname, '../../app.tsx'), 'utf8');
        expect(app).toContain('<AoideSyncOnLaunchEffect />');
    });

    it('waits for a server that can push, not merely for mount', () => {
        expect(effect).toMatch(/if \(!canPushLocalEdits\) return;/);
        expect(effect).toContain('[canPushLocalEdits, queryClient, repairOnce, serverId, sync]');
    });

    it('listens for the window coming back, both ways it can', () => {
        expect(effect).toContain("window.addEventListener('focus'");
        expect(effect).toContain("document.addEventListener('visibilitychange'");
        expect(effect).toContain('isFocusSyncDue(lastStartedAt.current, Date.now())');
    });

    // Every alt-tab is a focus event, and a music player is left open for days.
    it('never syncs on focus more often than once a minute', () => {
        expect(FOCUS_SYNC_MIN_INTERVAL_MS).toBeGreaterThanOrEqual(60_000);
    });

    // A sidecar that is down is logged, never announced. A player that toasts
    // every time the laptop wakes up is a player somebody turns this off on.
    it('never raises a toast', () => {
        // The call and the import, not the word: the comment explaining why
        // there is no toast is worth keeping.
        expect(effect).not.toMatch(/\btoast\.\w+\(/);
        expect(effect).not.toContain('components/toast/toast');
        expect(effect).toContain('logger.warn');
    });

    it('refreshes Jellyfin’s own playlist list after applied ops', () => {
        expect(effect).toMatch(/outcome\.result\.applied > 0/);
        expect(effect).toContain('queryKeys.playlists.list(serverId)');
    });
});

describe('"Add to Aoide playlist" is offered wherever "Add to playlist" is', () => {
    // The report: on the desktop you could add music to a Jellyfin playlist
    // and not to an Aoide one. The Aoide entry was wired into the song menu
    // alone; every other menu carried only Feishin's.
    const menus = [
        'album-artist-context-menu',
        'album-context-menu',
        'artist-context-menu',
        'folder-context-menu',
        'genre-context-menu',
        'playlist-context-menu',
        'playlist-song-context-menu',
        'queue-context-menu',
        'song-context-menu',
    ];

    for (const menu of menus) {
        it(`${menu} renders the Aoide entry beside the Jellyfin one`, () => {
            const source = readFileSync(
                join(import.meta.dirname, `../../features/context-menu/menus/${menu}.tsx`),
                'utf8',
            );

            expect(source).toContain('<AddToPlaylistAction ');
            expect(source).toContain('<AddToAoidePlaylistAction ');
        });
    }

    const action = sourceOf('playlists/add-to-aoide-playlist-action.tsx');

    // Upstream hands genre ids to its own action typed as ALBUM. Ids are ids
    // there; here they decide which lookup runs, so the Aoide entry says GENRE.
    it('tells the genre menu’s ids apart from album ids', () => {
        const genre = readFileSync(
            join(import.meta.dirname, '../../features/context-menu/menus/genre-context-menu.tsx'),
            'utf8',
        );
        expect(genre).toContain(
            '<AddToAoidePlaylistAction items={ids} itemType={LibraryItem.GENRE} />',
        );
    });

    // Right-clicking a discography must not download it. The songs are worked
    // out inside the selection handler, not in a hook that runs on open.
    it('resolves songs when a playlist is chosen, not when the menu opens', () => {
        expect(action).toMatch(/const collectTracks = useCallback\(async/);
        expect(action).not.toMatch(/useQuery\(|useEffect\(/);
        expect(action).toContain('resolveSongsForSelection(itemType, items, fetchers)');
    });

    it('keeps the fast path for menus that already hold the songs', () => {
        expect(action).toContain('if (songs) return songs.map(trackInputFromSong);');
    });

    it('grows a search box past a handful of playlists, like its sibling', () => {
        expect(action).toContain('playlists.length > PLAYLIST_SEARCH_THRESHOLD');
        expect(action).toContain('stickyContent={searchInput}');
    });
});

describe('the cover repair', () => {
    const effect = sourceOf('sync/aoide-sync-on-launch-effect.tsx');
    const panel = sourceOf('sync/aoide-sync-panel.tsx');
    const hook = sourceOf('playlists/use-cover-repair.ts');

    // The sync is what brings in the playlists the phone imported, and they
    // are the only ones the repair is for.
    it('runs once, after the first sync that worked', () => {
        expect(effect).toContain('await repairOnce()');
        // After the error return, so a failed sync never triggers it.
        expect(effect.indexOf("if (outcome.phase === 'error')")).toBeLessThan(
            effect.indexOf('await repairOnce()'),
        );
        expect(hook).toContain('if (repairedThisLaunch) return 0;');
    });

    it('can be asked for from the sync panel', () => {
        expect(panel).toContain('aoide.sync.repairCovers');
        expect(panel).toMatch(/await repair\(\)/);
    });

    // Every write goes through the bridge so an op is logged and the phone
    // gets the cover too. A SQL statement here would fix this machine only.
    it('writes through setArtwork and nothing else', () => {
        expect(hook).toContain('aoidePlaylists().setArtwork(step.playlistId, step.artworkItemId)');
        expect(hook).not.toContain('sourceJellyfinId');
    });

    it('is published by preload and handled by main', () => {
        const preload = readFileSync(
            join(import.meta.dirname, '../../../preload/aoide.ts'),
            'utf8',
        );
        const main = readFileSync(
            join(import.meta.dirname, '../../../main/features/aoide/index.ts'),
            'utf8',
        );

        expect(preload).toContain("ipcRenderer.invoke('aoide:playlists-set-artwork'");
        expect(main).toContain("'aoide:playlists-set-artwork'");
    });
});

describe('a playlist with no cover shows its first track’s', () => {
    // Every imported playlist drew a grey icon, which reads as broken rather
    // than as "no cover".
    it('on the detail hero', () => {
        const detail = sourceOf('playlists/aoide-playlist-detail.tsx');
        expect(detail).toContain('usePlaylistCoverOrFirstTrack(playlist, HEADER_ARTWORK_WIDTH)');
    });

    it('on the list card', () => {
        const list = sourceOf('playlists/aoide-playlist-list.tsx');
        expect(list).toContain('usePlaylistCoverOrFirstTrack(playlist, HEADER_ARTWORK_WIDTH)');
    });

    it('in the sidebar row', () => {
        const sidebar = sourceOf('sidebar/aoide-sidebar-list.tsx');
        expect(sidebar).toContain('usePlaylistCoverOrFirstTrack(');
    });

    it('prefers a real cover and falls back only when there is none', () => {
        const hook = sourceOf('playlists/use-playlist-cover.ts');
        expect(hook).toMatch(
            /if \(cover\) return cover;\s*\n\s*if \(!playlist\.firstTrack\) return null;/,
        );
    });
});

describe('the playlist import is reachable and judges with the shared rules', () => {
    const router = readFileSync(join(import.meta.dirname, '../../router/app-router.tsx'), 'utf8');
    const sidebar = sourceOf('sidebar/aoide-sidebar-list.tsx');
    const hook = sourceOf('import/use-playlist-import.ts');
    const main = readFileSync(
        join(import.meta.dirname, '../../../main/features/aoide/index.ts'),
        'utf8',
    );

    it('has a route and a sidebar row', () => {
        expect(router).toContain('AppRoute.AOIDE_IMPORT');
        expect(sidebar).toContain('AppRoute.AOIDE_IMPORT');
    });

    it('registers the main-process fetch the preload calls', () => {
        expect(main).toContain('registerPlaylistImportHandlers()');
    });

    // The point of the shared specification: the desktop must not grow its own
    // idea of a match. It searches by the normalised title and lets `best` judge.
    it('asks the sidecar first and keeps the local matcher as the fallback', () => {
        expect(hook).toContain('transport.match(imported.tracks)');
        expect(hook).toContain('const served = await matchOnServer(imported)');
    });

    it('listens for the CSV Exportify saves', () => {
        expect(hook).toContain('window.api.aoide.import.onCsv(');
    });

    it('searches by the normalised title and decides with the shared matcher', () => {
        expect(hook).toContain('searchTerm: term.slice(0, 60)');
        expect(hook).toContain('searchTerms(track.title)');
        expect(hook).toContain('best(track, songs.map(candidateFromSong))');
    });
});

describe('the Now Playing column', () => {
    const column = sourceOf('now-playing/aoide-now-playing-column.tsx');
    const lyrics = sourceOf('now-playing/aoide-now-playing-lyrics.tsx');
    const hook = sourceOf('now-playing/use-now-playing-column.ts');
    const rightSidebar = readFileSync(
        join(import.meta.dirname, '../../layouts/default-layout/right-sidebar.tsx'),
        'utf8',
    );
    const mainContent = readFileSync(
        join(import.meta.dirname, '../../layouts/default-layout/main-content.tsx'),
        'utf8',
    );

    // The layout's right slot is Feishin's side queue. The column takes that
    // slot behind the preference, and the grid opens the slot for it whether
    // or not the queue toggle is on — a persistent column that only appeared
    // after pressing the queue button would not be persistent.
    it('is mounted in the default layout behind the preference', () => {
        expect(rightSidebar).toContain('const nowPlayingColumn = useAoideNowPlayingColumn();');
        expect(rightSidebar).toMatch(
            /if \(nowPlayingColumn\) \{\s*return \(\s*<AoideNowPlayingColumn/,
        );
        expect(mainContent).toContain(
            "nowPlayingColumn || (rightExpanded && sideQueueType === 'sideQueue')",
        );
    });

    // Both the JS and the CSS ask the same media query, from one constant.
    it('collapses through the shared media query rather than a second number', () => {
        expect(hook).toContain('window.matchMedia(COLUMN_MEDIA_QUERY)');
        expect(hook).not.toMatch(/1100/);
    });

    // The goal is the phone's hierarchy on a wide screen, not a new player
    // engine: controls, seek and the queue list are Feishin's own.
    it('reuses Feishin’s controls and side-queue list', () => {
        expect(column).toContain('<CenterControls />');
        expect(column).toContain('listKey={ItemListKey.SIDE_QUEUE}');
        expect(column).not.toMatch(/setTimestamp\(|mediaSeekToTimestamp/);
    });

    it('fetches lyrics through Feishin’s query', () => {
        expect(lyrics).toContain('lyricsQueries.songLyrics(');
    });

    // The phone: active line at full opacity, every other line at 45%. The
    // number is the helper's, and the style reads it rather than restating it.
    it('dims inactive lines with the constant from the helper module', () => {
        expect(INACTIVE_LINE_OPACITY).toBe(0.45);
        expect(lyrics).toMatch(/opacity: index === active \? 1 : INACTIVE_LINE_OPACITY/);
        expect(lyrics).not.toMatch(/0\.45/);
    });

    it('decides the active line and the scroll target with the tested helpers', () => {
        expect(lyrics).toContain('activeLineIndex(lines, timestamp * 1000 + offsetMs)');
        expect(lyrics).toContain('scrollTopForLine(');
    });
});
