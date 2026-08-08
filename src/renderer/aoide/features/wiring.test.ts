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
