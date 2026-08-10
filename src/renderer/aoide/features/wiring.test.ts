import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { syncOutcome } from './sync/sync-report';

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

    it('is reachable from the sidebar', () => {
        expect(sourceOf('sidebar/aoide-sidebar-list.tsx')).toContain('AOIDE_SEARCH');
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

    it('offers the description path only for a real phrase with a key set', () => {
        expect(source).toMatch(/smart\.canInterpret && looksLikeAPhrase\(text\)/);
        expect(hook).toContain('looksLikeAPhrase');
    });
});
