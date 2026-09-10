import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { RESUME_GRID_LIMIT } from './home/recent-contexts';
import { INACTIVE_LINE_OPACITY } from './now-playing/now-playing-column';
import { DEFAULT_AOIDE_LOUDNESS_NORMALISATION } from './playback/loudness-normalisation';
import { syncOutcome } from './sync/sync-report';
import { FOCUS_SYNC_MIN_INTERVAL_MS } from './sync/sync-schedule';

import { ACTIVITIES } from '/@/shared/aoide/activity';

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

    // The phone's two additions. A description can name a band, an album, a
    // game; the library is searched for it — songs, whole albums, the
    // artist's songs — and those go first.
    it('searches the library for what the description names, and puts it first', () => {
        expect(hook).toContain('searchNames(outcome.names');
        expect(hook).toContain('api.controller.search(');
        expect(hook).toContain('albumIds: [...albumIds]');
        expect(hook).toContain('artistIds: [artistId]');
        expect(hook).toContain('orderCandidates(');
        expect(hook).toMatch(/orderCandidates\(\s*named\.ids/);
        expect(hook).toContain('namesFirst(');
    });

    // The model's "rock" is this library's "Rock", "Hard Rock" and
    // "Alternative Rock", and Jellyfin ORs the ids it is handed.
    it('maps the model’s genres to the library’s by word, not by exact name', () => {
        expect(hook).toContain('matchGenres(describedGenres(rules), genreNames)');
        expect(hook).not.toMatch(/genreIdsByName\.get\(String\(rule\.value\)\)/);
        expect(hook).toContain('genreIds,');
    });

    it('does not ask for the whole library beside a name', () => {
        expect(hook).toContain('wantsRuleCandidates(rules, outcome.names)');
    });

    it('goes on with names alone when the rules were refused', () => {
        expect(hook).toContain('!outcome.rules && outcome.names.length === 0');
    });

    // The diagnostic. An empty mix with no account of what was looked for
    // cannot be rephrased.
    it('shows what was understood under the input', () => {
        expect(hook).toContain('describePlan({ genres, names: outcome.names, rules })');
        expect(screen).toContain("t('aoide.mix.lookedFor', { plan: mix.plan })");
    });

    it('names the things the library had nothing for', () => {
        expect(hook).toContain('missedNamesMessage(missed)');
        expect(screen).toContain("t('aoide.mix.missed', { names: mix.missed.join(', ') })");
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
        const pickUp = sourceOf('queue/pick-up.ts');
        expect(pickUp).toMatch(/addToQueueByData\(songs, Play\.NOW, start\?\.id\)/);
        expect(panel).toContain('await pickUp(handoff, { player, queryClient, serverId })');
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

describe('Home opens on the last six things you were in', () => {
    const grid = sourceOf('home/resume-grid.tsx');
    const handlers = sourceOf('home/use-resume-context.ts');
    const home = readFileSync(
        join(import.meta.dirname, '../../features/home/routes/home-route.tsx'),
        'utf8',
    );

    it('is mounted at the top of the home route', () => {
        expect(home).toContain('<ResumeGrid />');
        // Above the feature carousel, which is the first thing Feishin draws.
        expect(home.indexOf('<ResumeGrid />')).toBeLessThan(
            home.indexOf('<AlbumInfiniteSingleFeatureCarousel />'),
        );
    });

    // Six: the phone's "last six things", two rows of three. The number is
    // the helper's, and the grid asks for it by name rather than restating it.
    it('caps at six through the shared limit', () => {
        expect(RESUME_GRID_LIMIT).toBe(6);
        expect(grid).toContain(
            'resumeTiles(recent, handoff, handoff?.receivedAt ?? 0, RESUME_GRID_LIMIT)',
        );
        expect(grid).not.toContain('Date.now()');
        expect(grid).toContain('useRecentContexts(serverId, RESUME_GRID_LIMIT)');
        expect(grid).not.toMatch(/[^A-Za-z_]6[^0-9]/);
    });

    // A placeholder on a page already full of things to play only pushes
    // them down.
    it('renders nothing when there is nothing to resume', () => {
        expect(grid).toContain('if (tiles.length === 0) return null;');
    });

    it('resumes through the pages’ own play helpers and the shared pick-up', () => {
        expect(handlers).toContain('LibraryItem.ALBUM, Play.NOW');
        expect(handlers).toContain('LibraryItem.PLAYLIST,');
        expect(handlers).toContain('resolvePlaylistPlayback(');
        expect(handlers).toContain('songsQueries.artistRadio(');
        expect(handlers).toContain('songsQueries.albumRadio(');
        expect(handlers).toContain('pickUp(handoff, { player, queryClient, serverId })');
    });

    // Recorded where playback starts from the thing's own page, and nowhere
    // else — a grid that fills with shuffle-alls is a grid nobody looks at.
    const recorders: [string, string][] = [
        [
            '../../features/albums/components/album-detail-header.tsx',
            'rememberAlbum(server.id, detailQuery?.data)',
        ],
        [
            '../../features/albums/components/album-detail-header.tsx',
            "rememberStation(server.id, 'album', detailQuery?.data)",
        ],
        [
            '../../features/playlists/components/playlist-detail-song-list-header.tsx',
            'rememberJellyfinPlaylist(server?.id, detailQuery?.data)',
        ],
        [
            '../../features/artists/components/album-artist-detail-content.tsx',
            "rememberStation(server.id, 'artist'",
        ],
        [
            'playlists/aoide-playlist-detail.tsx',
            'rememberAoidePlaylist(serverId, playlistQuery.data)',
        ],
        ['mix/aoide-mix.tsx', 'rememberMix(serverId, description)'],
    ];

    for (const [file, call] of recorders) {
        it(`${file.split('/').pop()} records ${call.split('(')[0]}`, () => {
            expect(readFileSync(join(import.meta.dirname, file), 'utf8')).toContain(call);
        });
    }

    // A mix tile reopens the page with the words filled in rather than
    // silently spending a model request.
    it('hands a mix its description back', () => {
        expect(handlers).toContain(
            'navigate(AppRoute.AOIDE_MIX, { state: { description: context.name } })',
        );
        expect(sourceOf('mix/aoide-mix.tsx')).toContain('?.description ??');
    });
});

describe('the built-in playlists are made at startup', () => {
    const main = readFileSync(
        join(import.meta.dirname, '../../../main/features/aoide/index.ts'),
        'utf8',
    );
    const preload = readFileSync(join(import.meta.dirname, '../../../preload/aoide.ts'), 'utf8');

    // The store is one per machine, so nothing about the account has to be
    // known first — only that the database opened. An `ensureBuiltIns` that is
    // written but never called at launch seeds exactly as many rows as none.
    it('runs once the store is open, in the same chain that opens it', () => {
        expect(main).toMatch(
            /app\.whenReady\(\)\s*\.then\(\(\) => curation\(\)\)\s*\.then\(\(\{ playlists \}\) => \{\s*const created = playlists\.ensureBuiltIns\(\);/,
        );
    });

    it('is published by preload and handled by main', () => {
        expect(preload).toContain("ipcRenderer.invoke('aoide:playlists-ensure-built-ins')");
        expect(main).toContain("'aoide:playlists-ensure-built-ins'");
    });
});

describe('Replay: listening as a story', () => {
    const router = readFileSync(join(import.meta.dirname, '../../router/app-router.tsx'), 'utf8');
    const sidebar = sourceOf('sidebar/aoide-sidebar-list.tsx');
    const page = sourceOf('replay/aoide-replay.tsx');
    const hook = sourceOf('replay/use-replay.ts');
    const css = sourceOf('replay/aoide-replay.module.css');

    it('has a route and a sidebar row', () => {
        expect(router).toContain('AppRoute.AOIDE_REPLAY');
        expect(router).toContain('<AoideReplayRoute />');
        expect(sidebar).toContain('AppRoute.AOIDE_REPLAY');
    });

    // The counting is the main process's, by the one shared definition of a
    // play. A page that aggregated events itself would be a second definition.
    it('asks the main process for the recap and computes only the window start', () => {
        expect(hook).toContain(
            'window.api.aoide.history.recap(periodStart(period, new Date(now)), now)',
        );
        expect(page).toContain('useReplay(period, serverId)');
        expect(page).not.toMatch(/play_events|countsAsPlay/);
    });

    it('takes the moment inside the query, never in render', () => {
        expect(page).not.toContain('Date.now()');
        expect(hook).toMatch(/queryFn: \(\) => \{\s*const now = Date\.now\(\);/);
    });

    it('resolves top songs by id, in rank order, and plays them from the clicked one', () => {
        expect(hook).toContain('getSongById({ id, queryClient, serverId })');
        expect(page).toContain('songs[index].song.id');
        expect(page).toMatch(/Play\.NOW,\s*songs\[index\]\.song\.id/);
        expect(page).not.toMatch(/\baddToQueueByFetch\s*\(/);
    });

    it('says when nothing was played, and counts what it cannot name', () => {
        expect(page).toContain('data.totalPlays === 0');
        expect(page).toContain('aoide.replay.empty');
        expect(page).toContain('data.unattributedPlays > 0');
    });

    it('lines the numbers up with tabular digits', () => {
        expect(css).toContain('font-variant-numeric: tabular-nums;');
    });
});

describe('what is played at this desk is recorded', () => {
    const effect = sourceOf('history/aoide-play-recorder-effect.tsx');
    const app = readFileSync(join(import.meta.dirname, '../../app.tsx'), 'utf8');
    const preload = readFileSync(join(import.meta.dirname, '../../../preload/aoide.ts'), 'utf8');
    const main = readFileSync(
        join(import.meta.dirname, '../../../main/features/aoide/index.ts'),
        'utf8',
    );

    // Until this existed the store only ever received play events from the
    // phone. A recorder that is written but not mounted records exactly as
    // much as none.
    it('is mounted with the app’s other effects', () => {
        expect(app).toContain('<AoidePlayRecorderEffect />');
    });

    it('only in a build with a store to write to', () => {
        expect(effect).toContain('isAoideAvailable() ? <Recorder /> : null');
    });

    // Every transition is the pure module's; the effect forwards events in and
    // calls out. A rule that lived in the effect would be a rule with no test.
    it('decides every transition in the pure module', () => {
        for (const transition of [
            'onContextStarted(',
            'onQueueReplaced(',
            'onStatusChanged(',
            'onStop(',
            'onTick(',
            'onTrackChanged(',
            'queueWasReplaced(',
        ]) {
            expect(effect).toContain(transition);
        }
    });

    it('measures listening from the player’s own progress samples, not a timer of its own', () => {
        expect(effect).toContain('onPlayerProgress');
        expect(effect).toContain('usePlayerEvents(');
        expect(effect).not.toMatch(/setInterval|setTimeout|requestAnimationFrame/);
    });

    it('reads the status at the moment of the sample, the way the scrobbler does', () => {
        expect(effect).toContain(
            'usePlayerStore.getState().player.status === PlayerStatus.PLAYING',
        );
    });

    it('finishes the open listen when the window goes, and when it unmounts', () => {
        expect(effect).toContain("window.addEventListener('beforeunload', finish)");
        expect(effect).toMatch(/return \(\) => \{[\s\S]*finish\(\);\s*\};/);
    });

    // The event id arrives asynchronously; a finish sent before its begin
    // resolved would name an id the store has never seen and be ignored.
    it('waits for the begin before finishing', () => {
        expect(effect).toContain('eventIds.current.get(call.token)');
        expect(effect).toMatch(/pending\.then\(\(eventId\) =>/);
    });

    it('hears a page announce what it started playback from', () => {
        expect(effect).toContain('useRecentContextsStore.subscribe(');
        expect(sourceOf('home/use-recent-contexts.ts')).toContain('smart: playlist.isSmart');
    });

    it('is published by preload and handled by main', () => {
        expect(preload).toContain("ipcRenderer.invoke('aoide:history-begin-play'");
        expect(preload).toContain("ipcRenderer.invoke('aoide:history-finish-play'");
        expect(main).toContain("'aoide:history-begin-play'");
        expect(main).toContain("'aoide:history-finish-play'");
    });

    // The SQL judges the threshold arm against the cache's duration. An
    // uncached track is judged on the duration-free half of the rule, and the
    // Replay page has nothing to file it under.
    it('caches the track before opening the listen', () => {
        const handler = main.indexOf("'aoide:history-begin-play'");
        const cache = main.indexOf('playlists.cacheTracks([track])', handler);
        const begin = main.indexOf('history.beginPlay(', handler);

        expect(handler).toBeGreaterThan(-1);
        expect(cache).toBeGreaterThan(handler);
        expect(begin).toBeGreaterThan(cache);
    });

    // The whole reason for the shared definition. A second one — a literal
    // four minutes anywhere in the renderer, or the classifier called from it —
    // is the drift that made two devices disagree about the same listen.
    it('holds no play definition of its own', () => {
        const sources = (root: string): string[] =>
            readdirSync(root, { recursive: true, withFileTypes: true })
                .filter(
                    (entry) =>
                        entry.isFile() &&
                        /\.tsx?$/.test(entry.name) &&
                        !/\.test\.tsx?$/.test(entry.name),
                )
                .map((entry) => join(entry.parentPath, entry.name));

        const renderer = sources(join(import.meta.dirname, '..'));
        const mainProcess = sources(join(import.meta.dirname, '../../../main/features/aoide'));
        expect(renderer.length).toBeGreaterThan(0);

        for (const file of [...renderer, ...mainProcess]) {
            const text = readFileSync(file, 'utf8');
            expect(text, file).not.toMatch(/\b240(_000|000)?\b|\b4 \* 60\b/);
        }

        for (const file of renderer) {
            const text = readFileSync(file, 'utf8');
            // The import, not the word: the effect's comment names the file
            // to say where the verdict lives, and that is worth keeping.
            expect(text, file).not.toMatch(/from '[^']*play-definition'/);
            expect(text, file).not.toMatch(/\bclassify\(|countsAsPlay/);
        }
    });
});

describe('taste flags: the phone’s "Not Interested" and "Don’t Count Plays"', () => {
    const action = sourceOf('taste/taste-flag-actions.tsx');
    const settings = sourceOf('settings/hidden-from-mixes-settings.tsx');
    const station = sourceOf('home/use-resume-context.ts');
    const preload = readFileSync(join(import.meta.dirname, '../../../preload/aoide.ts'), 'utf8');
    const main = readFileSync(
        join(import.meta.dirname, '../../../main/features/aoide/index.ts'),
        'utf8',
    );
    const history = readFileSync(
        join(import.meta.dirname, '../../../main/features/aoide/play-history.ts'),
        'utf8',
    );
    const mix = readFileSync(
        join(import.meta.dirname, '../../../main/features/aoide/mix.ts'),
        'utf8',
    );
    const generalTab = readFileSync(
        join(import.meta.dirname, '../../features/settings/components/general/general-tab.tsx'),
        'utf8',
    );

    // Beside "Add to Aoide playlist" in the three menus that hold whole songs.
    // The other menus hold albums, artists and folders, and a flag is a
    // judgement about one song.
    for (const menu of ['playlist-song-context-menu', 'queue-context-menu', 'song-context-menu']) {
        it(`${menu} renders the flag items beside the Aoide playlist entry`, () => {
            const source = readFileSync(
                join(import.meta.dirname, `../../features/context-menu/menus/${menu}.tsx`),
                'utf8',
            );

            expect(source).toContain('<AddToAoidePlaylistAction songs={items} />');
            expect(source).toContain('<TasteFlagActions songs={items} />');
        });
    }

    it('reads the current flags through the query hook and writes through the mutation', () => {
        expect(action).toContain('useTrackFlags(song?.id)');
        expect(action).toContain('useSetTrackFlag()');
        expect(action).toContain("toggle('notInterested', !notInterested)");
        expect(action).toContain("toggle('dontCount', !dontCount)");
    });

    // Each item reads as the action it will take, as on the phone.
    it('offers the undo wording once a flag is set', () => {
        expect(action).toContain("t('aoide.taste.offerAgain') : t('aoide.taste.notInterested')");
        expect(action).toContain("t('aoide.taste.countPlays') : t('aoide.taste.dontCount')");
    });

    it('renders nothing without a store, and is disabled over a selection', () => {
        expect(action).toContain('if (!isAoideAvailable() || songs.length === 0) return null;');
        expect(action).toContain('songs.length === 1 ? songs[0] : undefined');
        expect(action).toContain('disabled={!song}');
    });

    it('lists the flagged tracks in the general settings tab, with a way to clear each', () => {
        // The mount, not the name: the import line alone would satisfy the
        // name, and a section that is imported and never mounted is a list
        // nobody can reach.
        expect(generalTab).toContain(
            "{ component: HiddenFromMixesSettings, key: 'aoideHiddenFromMixes' }",
        );
        expect(settings).toContain('useFlaggedTracks()');
        expect(settings).toContain('useClearTrackFlags()');
        expect(settings).toContain('clear.mutate(entry.jellyfinId');
        // A track the cache does not know is still listed, by its id.
        expect(settings).toContain('entry.title ?? entry.jellyfinId');
    });

    // The recorder's path: main reads the flag before it opens the row, and
    // a null begin is, to the effect, nothing to finish.
    it('checks "don’t count" before opening a play event', () => {
        const begin = history.indexOf('beginPlay(input: BeginPlayInput): null | string');
        const check = history.indexOf('if (this.dontCount(input.jellyfinId)) return null;', begin);
        const open = history.indexOf("this.store.record('play_events'", begin);

        expect(begin).toBeGreaterThan(-1);
        expect(check).toBeGreaterThan(begin);
        expect(open).toBeGreaterThan(check);
        expect(sourceOf('history/aoide-play-recorder-effect.tsx')).toContain(
            'Promise<null | string | undefined>',
        );
    });

    // Mixes are narrowed in main; a station is seeded by Jellyfin and filtered
    // here before it reaches the queue.
    it('drops hidden tracks from mixes and from a re-seeded station', () => {
        expect(mix).toContain('notInterestedAmong(this.db, candidateIds)');
        expect(station).toContain('await dropNotInterested(seeded ?? [])');
        expect(sourceOf('taste/not-interested.ts')).toContain('flags.notInterestedAmong(');
    });

    it('is published by preload and handled by main', () => {
        for (const channel of [
            'aoide:flags-get',
            'aoide:flags-set-not-interested',
            'aoide:flags-set-dont-count',
            'aoide:flags-clear',
            'aoide:flags-flagged',
            'aoide:flags-not-interested-among',
        ]) {
            expect(preload).toContain(`ipcRenderer.invoke('${channel}'`);
            expect(main).toContain(`'${channel}'`);
        }
    });

    // The settings list names tracks from the cache, and the content key is
    // computed in main from the same metadata the phone computes it from.
    it('caches the track and computes its key in main when a flag is set', () => {
        for (const channel of ['aoide:flags-set-not-interested', 'aoide:flags-set-dont-count']) {
            const handler = main.indexOf(`'${channel}'`);
            const cache = main.indexOf('playlists.cacheTracks([track])', handler);
            const key = main.indexOf('track.contentKey ?? contentKeyFor(track)', handler);

            expect(handler).toBeGreaterThan(-1);
            expect(cache).toBeGreaterThan(handler);
            expect(key).toBeGreaterThan(cache);
        }
    });
});

describe('silence trimming: both players consult the trim plan, the setting gates it', () => {
    const webPlayer = readFileSync(
        join(import.meta.dirname, '../../features/player/audio-player/web-player.tsx'),
        'utf8',
    );
    const mpvMain = readFileSync(
        join(import.meta.dirname, '../../../main/features/core/player/index.ts'),
        'utf8',
    );
    const mpvTrim = readFileSync(
        join(import.meta.dirname, '../../../main/features/aoide/mpv-trim.ts'),
        'utf8',
    );
    const store = sourceOf('playback/sound-bounds-store.ts');
    const players = sourceOf('playback/use-trim-players.ts');
    const effect = sourceOf('playback/aoide-trim-effect.tsx');
    const settings = readFileSync(
        join(import.meta.dirname, '../../store/settings.store.ts'),
        'utf8',
    );
    const generalTab = readFileSync(
        join(import.meta.dirname, '../../features/settings/components/general/general-tab.tsx'),
        'utf8',
    );
    const app = readFileSync(join(import.meta.dirname, '../../app.tsx'), 'utf8');
    const preload = readFileSync(join(import.meta.dirname, '../../../preload/aoide.ts'), 'utf8');
    const main = readFileSync(
        join(import.meta.dirname, '../../../main/features/aoide/index.ts'),
        'utf8',
    );

    // The web player: a hook over its two slots, fed from the same progress
    // samples it scrobbles and crossfades from.
    it('the web player feeds both slots’ progress to the trim hook', () => {
        expect(webPlayer).toContain('useTrimPlayers({ num, player1, player2, playerRef })');
        expect(webPlayer).toContain('trim.onProgress1(e.playedSeconds)');
        expect(webPlayer).toContain('trim.onProgress2(e.playedSeconds)');
    });

    it('the web player’s hook decides with the pure tracker and the shared plan', () => {
        expect(players).toContain('trimFor(bounds1, player1?.duration)');
        expect(players).toContain('trimFor(bounds2, player2?.duration)');
        expect(players).toMatch(/step\(tracker1\.current, plan1, playedSeconds\)/);
        expect(players).toMatch(/step\(tracker2\.current, plan2, playedSeconds\)/);
    });

    // Ending early runs Feishin's own `ended` path: the element is seeked to
    // its end and fires `ended`, which `onEnded` is wired to. Nothing of
    // `handleOnEndedPlayerN` is restated. Only the audible slot may do it.
    it('ends a track through the element’s own ended event, only from the audible slot', () => {
        expect(players).toContain('element.currentTime = element.duration');
        expect(players).toContain('if (slot !== num) return;');
        expect(players).not.toMatch(/\bmediaAutoNext\s*\(/);
    });

    it('seeks the way Feishin seeks', () => {
        expect(players).toContain("ref.seekTo(action.toSec, 'seconds')");
    });

    // mpv: every load in Feishin's player goes through the trim-aware load,
    // and none goes around it.
    it('every mpv load goes through loadWithAoideOptions', () => {
        expect(mpvMain).toContain(
            "import { loadWithAoideOptions } from '/@/main/features/aoide/mpv-trim'",
        );
        expect(mpvMain.match(/loadWithAoideOptions\(getMpvInstance\(\), /g)).toHaveLength(4);
        expect(mpvMain).not.toMatch(/getMpvInstance\(\)\?\.load\(/);
    });

    // DOCS/man/input.rst: from 0.38.0 the third argument is an index and
    // options need -1 there. node-mpv's own load() gets this wrong.
    it('mpv gets start= and end= as per-file loadfile options, never as global properties', () => {
        expect(mpvTrim).toContain("mpv.command('loadfile', loadfileArgs(");
        expect(mpvTrim).toContain('mpvFileOptions(plan)');
        expect(mpvTrim).not.toMatch(/setProperty\(\s*['"](start|end)['"]/);
    });

    it('main learns the plans from the renderer, and forgets them on request', () => {
        expect(preload).toContain("ipcRenderer.send('aoide:trim-remember', plans)");
        expect(preload).toContain("ipcRenderer.send('aoide:trim-forget')");
        expect(mpvTrim).toContain("ipcMain.on('aoide:trim-remember'");
        expect(mpvTrim).toContain("ipcMain.on('aoide:trim-forget'");
        expect(main).toContain('registerTrimHandlers();');
    });

    it('the effect that tells main is mounted, only in a build with a main', () => {
        expect(app).toContain('<AoideTrimEffect />');
        expect(effect).toContain('isAoideAvailable() ? <Trimmer /> : null');
        expect(effect).toContain('window.api.aoide.trim.remember(update)');
        expect(effect).toContain('window.api.aoide.trim.forget()');
        expect(effect).toContain('trimFor(bounds, duration)');
    });

    // The setting gates every consumer at once: the hook answers undefined
    // when it is off, and the effect tells main to forget.
    it('the setting exists, defaults on, and is in the general tab', () => {
        expect(settings).toContain('aoideTrimSilence: AoideTrimSilenceSchema');
        expect(settings).toContain('aoideTrimSilence: DEFAULT_AOIDE_TRIM_SILENCE');
        expect(generalTab).toContain("{ component: TrimSilenceSettings, key: 'aoideTrimSilence' }");
        expect(sourceOf('settings/trim-silence-settings.tsx')).toContain(
            'aoideTrimSilence: e.currentTarget.checked',
        );
    });

    it('the setting gates the bounds every player reads', () => {
        expect(store).toContain('const enabled = useAoideTrimSilenceEnabled();');
        expect(store).toContain('const wanted = enabled ? trackId : undefined;');
        expect(effect).toContain('if (!enabled) {');
        expect(effect).toContain('if (!enabled || !client || key.length === 0) return;');
    });

    // Never a toast. A sidecar without the endpoint is the normal state today.
    it('a sidecar that cannot answer is logged, never toasted', () => {
        expect(store).toContain('logger.warn(');
        expect(store).not.toMatch(/\btoast\b\s*[.(]/);
        expect(store).not.toMatch(/import .*toast/);
        expect(store).toContain('if (answer.absent) {');
    });
});

describe('the Flatpak can find the mpv it ships', () => {
    // A Flatpak sandbox cannot see the host's mpv, so packaging/flatpak builds
    // one into /app/bin. If this candidate ever goes, the MPV backend inside the
    // Flatpak stops working with nothing on screen to say why — which is exactly
    // how the macOS path broke once before.
    const player = readFileSync(
        join(import.meta.dirname, '../../../main/features/core/player/index.ts'),
        'utf8',
    );

    it('lists /app/bin/mpv among the binary candidates', () => {
        expect(player).toContain("'/app/bin/mpv'");
    });

    it('still consults PATH first, so a user own build wins', () => {
        expect(player).toContain('...fromPath, ...MPV_BINARY_CANDIDATES');
    });
});

describe('loudness normalisation: both backends consult the gain module, the setting gates it', () => {
    const webPlayer = readFileSync(
        join(import.meta.dirname, '../../features/player/audio-player/web-player.tsx'),
        'utf8',
    );
    const mpvGain = readFileSync(
        join(import.meta.dirname, '../../../main/features/aoide/mpv-gain.ts'),
        'utf8',
    );
    const mpvTrim = readFileSync(
        join(import.meta.dirname, '../../../main/features/aoide/mpv-trim.ts'),
        'utf8',
    );
    const store = sourceOf('playback/audio-analysis-store.ts');
    const hook = sourceOf('playback/use-loudness-gain.ts');
    const effect = sourceOf('playback/aoide-loudness-effect.tsx');
    const settings = readFileSync(
        join(import.meta.dirname, '../../store/settings.store.ts'),
        'utf8',
    );
    const generalTab = readFileSync(
        join(import.meta.dirname, '../../features/settings/components/general/general-tab.tsx'),
        'utf8',
    );
    const app = readFileSync(join(import.meta.dirname, '../../app.tsx'), 'utf8');
    const preload = readFileSync(join(import.meta.dirname, '../../../preload/aoide.ts'), 'utf8');
    const main = readFileSync(
        join(import.meta.dirname, '../../../main/features/aoide/index.ts'),
        'utf8',
    );

    // The web player: a second factor into the gain node ReplayGain already
    // uses, so the two multiply. Multiplied rather than assigned — assigning
    // would silently throw ReplayGain away for every tagged file.
    it('the web player multiplies the loudness factor into each slot’s gain node', () => {
        expect(webPlayer).toContain('useLoudnessGain(player1)');
        expect(webPlayer).toContain('useLoudnessGain(player2)');
        expect(webPlayer).toContain('calculateReplayGain(player1) * loudness1');
        expect(webPlayer).toContain('calculateReplayGain(player2) * loudness2');
    });

    // The element volume is what the person's slider, the play/pause fades and
    // the crossfade all drive. Scaling it here would be two things writing one
    // number, and the fade would win.
    it('never touches the element volume to do it', () => {
        expect(hook).not.toMatch(/setVolume|\.volume\s*=/);
    });

    it('the web player’s hook decides with the shared module and nothing of its own', () => {
        expect(hook).toContain('normalisationGainDb({');
        expect(hook).toContain('linearGain(');
        expect(hook).toContain('hasReplayGain(song?.gain)');
        // No arithmetic on decibels outside loudness.ts.
        expect(hook).not.toMatch(/10\s*\*\*/);
    });

    // mpv: a per-file option on the same loadfile that carries the trim, so a
    // file can be trimmed and levelled at once.
    it('mpv gets the gain as a per-file af filter, beside the trim, never as a global', () => {
        expect(mpvGain).toContain('mpvGainOptions(db)');
        expect(mpvTrim).toContain('{ ...trimOptionsForUrl(url), ...gainOptionsForUrl(url) }');
        expect(mpvTrim).toContain('const options = aoideFileOptions(url);');
        // `volume` as a property is the person's own volume slider.
        expect(mpvGain).not.toMatch(/setProperty\(\s*['"](volume|af)['"]/);
    });

    it('main learns the gains from the renderer, and forgets them on request', () => {
        expect(preload).toContain("ipcRenderer.send('aoide:gain-remember', gains)");
        expect(preload).toContain("ipcRenderer.send('aoide:gain-forget')");
        expect(mpvGain).toContain("ipcMain.on('aoide:gain-remember'");
        expect(mpvGain).toContain("ipcMain.on('aoide:gain-forget'");
        expect(main).toContain('registerGainHandlers();');
    });

    it('the effect that tells main is mounted, only in a build with a main', () => {
        expect(app).toContain('<AoideLoudnessEffect />');
        expect(effect).toContain('isAoideAvailable() ? <Leveller /> : null');
        expect(effect).toContain('window.api.aoide.gain.remember(update)');
        expect(effect).toContain('window.api.aoide.gain.forget()');
        expect(effect).toContain('normalisationGainDb({');
    });

    it('the setting defaults to on', () => {
        expect(DEFAULT_AOIDE_LOUDNESS_NORMALISATION).toBe(true);
    });

    it('the setting exists, is defaulted, and is in the general tab', () => {
        expect(settings).toContain('aoideLoudnessNormalisation: AoideLoudnessNormalisationSchema');
        expect(settings).toContain(
            'aoideLoudnessNormalisation: DEFAULT_AOIDE_LOUDNESS_NORMALISATION',
        );
        expect(generalTab).toContain(
            "{ component: LoudnessNormalisationSettings, key: 'aoideLoudnessNormalisation' }",
        );
        expect(sourceOf('settings/loudness-normalisation-settings.tsx')).toContain(
            'aoideLoudnessNormalisation: e.currentTarget.checked',
        );
    });

    // The setting gates every consumer at once: the store answers undefined
    // when it is off, the hook passes it to the decision, and the effect tells
    // main to forget.
    it('the setting gates the gain every player reads', () => {
        expect(store).toContain('const enabled = useAoideLoudnessNormalisationEnabled();');
        expect(store).toContain('const wanted = enabled ? trackId : undefined;');
        expect(hook).toContain('const enabled = useAoideLoudnessNormalisationEnabled();');
        expect(hook).toContain('enabled,');
        expect(effect).toContain('if (!enabled) {');
        expect(effect).toContain('if (!enabled || !client || key.length === 0) return;');
    });

    // Never a toast. The endpoint does not exist on any sidecar yet, so a 404
    // is the normal state and means "normalise nothing".
    it('a sidecar that cannot answer is logged, never toasted', () => {
        expect(store).toContain('logger.warn(');
        expect(store).not.toMatch(/\btoast\b\s*[.(]/);
        expect(store).not.toMatch(/import .*toast/);
        expect(store).toContain('if (answer.absent) {');
    });
});

describe('the reference loudness is defined once', () => {
    /** Every `.ts`/`.tsx` under `src` that is not itself a test. */
    const sourceFiles = (dir: string): string[] =>
        readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
            const path = join(dir, entry.name);
            if (entry.isDirectory()) return sourceFiles(path);
            if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) return [];
            return [path];
        });

    // Two copies of the target level are two halves of the app normalising to
    // different loudnesses, and nothing on screen would ever say so — it just
    // sounds like the feature not working. `jellyfin-normalize.ts` held the
    // second copy before this feature existed and now imports the constant.
    it('appears as a literal only in loudness.ts', () => {
        const src = join(import.meta.dirname, '../../..');
        const naming = sourceFiles(src)
            .filter((path) => /(?<![\d.\w])-18(?![\d.])/.test(readFileSync(path, 'utf8')))
            .map((path) => path.slice(src.length + 1))
            .sort();

        expect(naming).toEqual([
            // A compressor threshold in dBFS. Unrelated, and named here so a
            // real second definition of the target cannot hide behind it.
            'renderer/features/settings/components/playback/eq-settings.tsx',
            'shared/aoide/loudness.ts',
        ]);
    });
});

describe('the finish rate, surfaced where you browse', () => {
    const component = sourceOf('finish-rate/aoide-finish-rate.tsx');
    const hook = sourceOf('finish-rate/use-finish-rate.ts');
    const album = readFileSync(
        join(import.meta.dirname, '../../features/albums/components/album-detail-header.tsx'),
        'utf8',
    );
    const artist = readFileSync(
        join(
            import.meta.dirname,
            '../../features/artists/components/album-artist-detail-header.tsx',
        ),
        'utf8',
    );
    const preload = readFileSync(join(import.meta.dirname, '../../../preload/aoide.ts'), 'utf8');
    const main = readFileSync(
        join(import.meta.dirname, '../../../main/features/aoide/index.ts'),
        'utf8',
    );

    // A component that is written and not mounted shows exactly as much as
    // none, which is the failure the play recorder already shipped with once.
    it('is mounted on the album page, over the tracklist that page already has', () => {
        expect(album).toContain('<AoideAlbumFinishRate ');
        expect(album).toContain('jellyfinIds={finishRateTrackIds}');
        expect(album).toContain('(detailQuery?.data?.songs ?? []).map((song) => song.id)');
    });

    it('is mounted on the artist page, under the name that page is showing', () => {
        expect(artist).toContain('<AoideArtistFinishRate ');
        expect(artist).toContain('artist={detailQuery.data?.name}');
    });

    it('is published by preload and handled by main', () => {
        expect(preload).toContain("ipcRenderer.invoke('aoide:history-finish-rates'");
        expect(preload).toContain("ipcRenderer.invoke('aoide:history-finish-rate-artist'");
        expect(main).toContain("'aoide:history-finish-rates'");
        expect(main).toContain("'aoide:history-finish-rate-artist'");
    });

    // One crossing of the process boundary for the whole record. The batched
    // call in the main process exists for this, and a page that asked per row
    // would quietly undo it.
    it('asks once for the whole tracklist', () => {
        expect(hook).toContain('window.api.aoide.history.finishRates([...jellyfinIds])');
        expect(hook).not.toMatch(/\.map\([^)]*finishRates/);
    });

    // Nothing at all below the floor: no dash, no "not enough plays yet", not
    // even the separator that would precede it.
    it('renders nothing when there is no figure', () => {
        expect(component).toContain('if (percent === undefined) return null;');
        expect(component).not.toMatch(/'—'|"—"|toFixed/);
    });

    /**
     * The one rule this feature is allowed to have, and the one place it lives.
     *
     * `finish-rate.ts` is a reimplementation target: the phone will be handed
     * the same three rules verbatim, exactly as it was for `play-definition.ts`.
     * A screen that compared against its own `3`, or divided its own counts,
     * would be a second definition — and the symptom is an album reading 78%
     * here and 71% there from the very same synced events, which nobody can
     * report usefully.
     */
    it('keeps the threshold and the aggregation in the shared module alone', () => {
        const sources = (root: string): string[] =>
            readdirSync(root, { recursive: true, withFileTypes: true })
                .filter(
                    (entry) =>
                        entry.isFile() &&
                        /\.tsx?$/.test(entry.name) &&
                        !/\.test\.tsx?$/.test(entry.name),
                )
                .map((entry) => join(entry.parentPath, entry.name));

        const shared = readFileSync(
            join(import.meta.dirname, '../../../shared/aoide/finish-rate.ts'),
            'utf8',
        );

        // Not vacuous: the rules really are in there, so the sweep below means
        // "only here" rather than "nowhere".
        expect(shared).toContain('MINIMUM_FINISH_SAMPLE = 3');
        expect(shared).toContain('counts.starts < MINIMUM_FINISH_SAMPLE');
        expect(shared).toContain('total.completed += one.completed');
        expect(shared).toContain('total.starts += one.starts');

        const elsewhere = [
            ...sources(join(import.meta.dirname, '..')),
            ...sources(join(import.meta.dirname, '../../../main/features/aoide')),
            join(import.meta.dirname, '../../features/albums/components/album-detail-header.tsx'),
            join(
                import.meta.dirname,
                '../../features/artists/components/album-artist-detail-header.tsx',
            ),
        ];
        expect(elsewhere.length).toBeGreaterThan(1);

        for (const file of elsewhere) {
            const text = readFileSync(file, 'utf8');
            // A second floor, whether by constant or by literal.
            expect(text, file).not.toMatch(/MINIMUM_FINISH_SAMPLE\s*=/);
            expect(text, file).not.toMatch(/\bstarts\s*[<>]=?\s*\d/);
            // A second division: the ratio is the shared module's to take.
            expect(text, file).not.toMatch(/completed\s*\/\s*[\w.]*starts/);
        }

        // The renderer sums through the shared helper rather than by hand, so
        // an album is its tracks' counts added up and not their rates averaged.
        expect(hook).toContain('finishRatePercent(totalFinishCounts(Object.values(query.data)))');
        expect(hook).not.toMatch(/reduce\(/);
    });
});

describe('the queue store keeps the manual lane', () => {
    const source = readFileSync(join(import.meta.dirname, '../../store/player.store.ts'), 'utf8');

    // The behavioural fix, and the reason for the whole feature: Play Last used
    // to append. During a twenty-track album that meant hearing the song in an
    // hour. Both halves are asserted — that it inserts through the lane, and
    // that the old append is gone — because leaving the old line in place while
    // adding the new one is the shape this has to rule out.
    it('sends Play Last to the end of the lane rather than the end of the queue', () => {
        expect(source).toContain("insertManualEntries(state, newUniqueIds, 'last')");
        expect(source).not.toMatch(
            /state\.queue\.default = \[\.\.\.state\.queue\.default, \.\.\.newUniqueIds\]/,
        );
    });

    it('sends Play Next to the front of the lane', () => {
        expect(source).toContain("insertManualEntries(state, newUniqueIds, 'next')");
    });

    // Only what the listener chose. An album track marked manual would put the
    // rest of the album inside "Next Up".
    it('marks only Play Next and Play Last as chosen by hand', () => {
        expect(source).toMatch(/const isManualPlay =\s*\n\s*playType === Play\.LAST \|\|/);
        expect(source).toContain('toQueueSong(item, isManualPlay)');
    });

    it('carries the unplayed lane into a new context, on both ways of starting one', () => {
        // Read before the queue is replaced, restored after.
        expect(source.match(/const keptLane = unplayedLane\(state\);/g)).toHaveLength(2);
        expect(source.match(/restoreLane\(\s*state,\s*keptLane,/g)).toHaveLength(2);
    });

    it('leaves the lane in place when shuffle is switched on or re-rolled', () => {
        expect(source.match(/shuffledOrderKeepingLane\(/g)?.length).toBeGreaterThanOrEqual(4);
        expect(source).toContain('shuffleAfterLane(');
        // The old regeneration scattered the lane along with everything else.
        expect(source).not.toMatch(
            /state\.queue\.shuffled = generateShuffledIndexes\(\s*state\.queue\.default\.length,?\s*\)/,
        );
    });

    // Refreshing a song's metadata rebuilds its queue entry from a plain Song,
    // which is exactly where a flag gets dropped without anyone noticing.
    it('keeps the flag when a queue entry is rebuilt', () => {
        expect(source).toContain('_manual: song._manual');
    });

    // The sidecar stores queue payloads verbatim and the phone does not read a
    // lane flag off the wire, so the flag stays on this device.
    it('never puts the flag on the wire', () => {
        const save = readFileSync(join(import.meta.dirname, 'queue/use-queue-handoff.ts'), 'utf8');
        expect(save).not.toContain('_manual');
    });
});

describe('the queue view shows the lane', () => {
    const source = sourceOf('../../features/now-playing/components/play-queue.tsx');

    it('asks the shared module for its sections rather than counting rows itself', () => {
        expect(source).toContain('queueSections(');
        expect(source).toContain('(song) => song._manual === true');
    });

    it('draws one heading per section', () => {
        expect(source).toContain('itemCount: section.count');
        expect(source).toContain('<QueueSectionHeader labelKey={section.labelKey} />');
    });

    // Sections describe the queue's runs. Over a filtered list they would be
    // headings measured against rows that are not there.
    it('drops the headings while a search is filtering the list', () => {
        expect(source).toMatch(
            /if \(debouncedSearchTerm \|\| sections\.length === 0\) \{\s*\n\s*return undefined;/,
        );
    });

    it('recomputes them when the playhead moves, not only when the queue changes', () => {
        expect(source).toMatch(/subscribeCurrentTrack\(\(e\) => \{[\s\S]{0,400}?setQueue\(\);/);
    });
});

describe('scrolling a grouped table', () => {
    const source = readFileSync(
        join(
            import.meta.dirname,
            '../../components/item-list/item-table-list/hooks/use-table-imperative-handle.ts',
        ),
        'utf8',
    );

    // A caller scrolls to an *item*; a grouped table has a heading row in front
    // of each group. Following the current song landed a few rows out without
    // this, which is the desktop's version of the offset bug the phone shipped.
    it('shifts an item index past the headings above it', () => {
        expect(source).toContain('sectionHeaderRowsBefore(index, groupItemCounts)');
    });

    // Arrow keys move the selection by item and then scroll to it, so they need
    // the same shift or the row they land on is not the row they highlighted.
    it('shifts the same way when the arrow keys move the selection', () => {
        const keyboard = readFileSync(
            join(
                import.meta.dirname,
                '../../components/item-list/item-table-list/hooks/use-table-keyboard-navigation.ts',
            ),
            'utf8',
        );
        expect(keyboard).toContain('sectionHeaderRowsBefore(newIndex, groupItemCounts)');
        expect(keyboard).toContain('const gridIndex = enableHeader ? rowIndex + 1 : rowIndex;');
    });
});

describe('activity tags: what you were doing, recorded with the listen', () => {
    const effect = sourceOf('history/aoide-play-recorder-effect.tsx');
    const store = sourceOf('activity/use-activity.ts');
    const control = sourceOf('activity/aoide-activity-button.tsx');
    const rightControls = readFileSync(
        join(import.meta.dirname, '../../features/player/components/right-controls.tsx'),
        'utf8',
    );
    const preload = readFileSync(join(import.meta.dirname, '../../../preload/aoide.ts'), 'utf8');
    const main = readFileSync(
        join(import.meta.dirname, '../../../main/features/aoide/index.ts'),
        'utf8',
    );

    // A picker nobody can reach while music is playing is a picker nobody uses,
    // and the tag is only ever set in the middle of listening. The player bar
    // is the one thing on screen at every such moment.
    it('is mounted in the player bar, not only in settings', () => {
        expect(rightControls).toContain('<AoideActivityButton />');
        expect(rightControls).toContain(
            "import { AoideActivityButton } from '/@/renderer/aoide/features/activity/aoide-activity-button'",
        );
    });

    // A tag left on quietly colours everything after it, and the data still
    // looks fine. The label on the button is the only thing that says so.
    it('shows the tag on the button rather than hiding it behind a click', () => {
        expect(control).toMatch(/activity \? t\(`aoide\.activity\.\$\{activity\}`\)/);
        expect(control).toContain("t('aoide.activity.none')");
    });

    it('offers the four and no list of its own', () => {
        expect(control).toContain('ACTIVITIES.map(');
        expect(control).toContain("from '/@/shared/aoide/activity'");
    });

    // The recorder reads the store; it does not hold the selection itself, and
    // the effect does not decide anything about it.
    it('is read by the play recorder', () => {
        expect(effect).toContain('useActivityStore.subscribe(');
        expect(effect).toContain('onActivityChanged(state.current, currentActivity())');
        expect(effect).toContain(
            '.beginPlay(call.track, call.source, call.startedAt, call.activity)',
        );
    });

    // The tag is stamped at the begin and is never sent again. If a finish
    // could carry one, a long listen would be retagged by whatever was set when
    // it happened to end.
    it('travels on the begin and never on the finish', () => {
        expect(preload).toContain(
            "ipcRenderer.invoke('aoide:history-begin-play', track, source, startedAt, activity)",
        );
        expect(preload).not.toMatch(/history-finish-play[^)]*activity/);
        expect(main).toContain('activity: parseActivity(activity)');
    });

    // localStorage is a file on disk, and an op payload is written by another
    // device. Neither is this process, so neither is believed.
    it('parses the value at every boundary it arrives through', () => {
        expect(store).toContain('parseActivity(state.activity)');
        expect(main).toContain('parseActivity(activity)');
        expect(
            readFileSync(
                join(import.meta.dirname, '../../../main/features/aoide/curation-store.ts'),
                'utf8',
            ),
        ).toContain('incoming.activity = parseActivity(incoming.activity)');
    });

    // The tag on a play event travels — it is a column on a row that syncs.
    // The *selection* does not: it says where this machine is, and the phone is
    // somewhere else. There is no entity for it and no op is written.
    it('keeps the selection on this device', () => {
        const syncTypes = readFileSync(
            join(import.meta.dirname, '../../../shared/aoide/sync-types.ts'),
            'utf8',
        );

        expect(syncTypes).not.toMatch(/'activit/i);
        expect(store).not.toMatch(/record\(|pendingOps|aoideSyncStore|window\.api/);
        expect(store).toContain("name: 'aoide-activity'");
    });

    /**
     * One copy of the value set, and the guard that keeps it that way.
     *
     * Two of the four could not be greppable on their own: `'focus'` is a DOM
     * event name and a Mantine prop, and a rule that failed on those would be
     * turned off. So this asks the two questions that are answerable — the
     * three unambiguous values appear nowhere else, and no other file spells
     * *two or more* of the four, which is what a second copy of the set looks
     * like however it is written.
     */
    describe('the four strings live in one file', () => {
        const OWNER = 'shared/aoide/activity.ts';
        const PIN = 'shared/aoide/activity.test.ts';

        const quoted = (value: string) => new RegExp(`['"\`]${value}['"\`]`);

        const sources = (): string[] =>
            readdirSync(join(import.meta.dirname, '../../..'), {
                recursive: true,
                withFileTypes: true,
            })
                .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name))
                .map((entry) => join(entry.parentPath, entry.name))
                .filter((path) => !path.endsWith(OWNER) && !path.endsWith(PIN));

        it('finds every file to look at', () => {
            expect(sources().length).toBeGreaterThan(100);
        });

        it('spells gaming, chores and commute nowhere else', () => {
            for (const path of sources()) {
                const text = readFileSync(path, 'utf8');
                for (const value of ACTIVITIES.filter((option) => option !== 'focus')) {
                    expect(text, `${value} in ${path}`).not.toMatch(quoted(value));
                }
            }
        });

        it('lets no other file spell two of them', () => {
            for (const path of sources()) {
                const text = readFileSync(path, 'utf8');
                const found = ACTIVITIES.filter((value) => quoted(value).test(text));
                expect(found.length, `${found.join(', ')} in ${path}`).toBeLessThan(2);
            }
        });
    });
});
