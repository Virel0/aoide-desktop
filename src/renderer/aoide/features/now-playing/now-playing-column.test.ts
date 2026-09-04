import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
    ACTIVE_LINE_ANCHOR,
    activeLineIndex,
    AoideNowPlayingColumnSchema,
    COLUMN_MEDIA_QUERY,
    COLUMN_MIN_WINDOW_WIDTH,
    DEFAULT_AOIDE_NOW_PLAYING_COLUMN,
    INACTIVE_LINE_OPACITY,
    scrollTopForLine,
    showsNowPlayingColumn,
} from './now-playing-column';

const read = (relative: string) => readFileSync(join(import.meta.dirname, relative), 'utf8');

describe('the Now Playing column preference', () => {
    // The column is the product: the brief's desktop form of the phone's Now
    // Playing. Someone who prefers the bar turns it off themselves.
    it('is on by default', () => {
        expect(DEFAULT_AOIDE_NOW_PLAYING_COLUMN).toBe(true);
        expect(AoideNowPlayingColumnSchema.parse(DEFAULT_AOIDE_NOW_PLAYING_COLUMN)).toBe(true);
    });

    it('shows only when enabled and the window is wide enough', () => {
        expect(showsNowPlayingColumn(true, true)).toBe(true);
        expect(showsNowPlayingColumn(true, false)).toBe(false);
        expect(showsNowPlayingColumn(false, true)).toBe(false);
        expect(showsNowPlayingColumn(false, false)).toBe(false);
    });

    it('collapses at about 1100px, and asks CSS the same question the JS does', () => {
        expect(COLUMN_MIN_WINDOW_WIDTH).toBe(1100);
        expect(COLUMN_MEDIA_QUERY).toBe('(min-width: 1100px)');
    });
});

describe('the settings store carries the preference', () => {
    // The store cannot be imported here — it pulls in i18n and half the
    // renderer — so the wiring is read from its source.
    const store = read('../../../store/settings.store.ts');

    it('validates it with the shared schema', () => {
        expect(store).toContain('aoideNowPlayingColumn: AoideNowPlayingColumnSchema,');
    });

    it('starts from the shared default rather than a literal of its own', () => {
        expect(store).toContain('aoideNowPlayingColumn: DEFAULT_AOIDE_NOW_PLAYING_COLUMN,');
    });

    it('is settable from the general settings tab', () => {
        const generalTab = read('../../../features/settings/components/general/general-tab.tsx');
        expect(generalTab).toContain('NowPlayingColumnSettings');
    });
});

describe('the phone’s lyric typography', () => {
    it('dims every line but the active one to 45%', () => {
        expect(INACTIVE_LINE_OPACITY).toBe(0.45);
    });

    it('keeps the active line a third of the way down', () => {
        expect(ACTIVE_LINE_ANCHOR).toBeCloseTo(1 / 3);
    });
});

describe('activeLineIndex', () => {
    const lines = [{ startMs: 1_000 }, { startMs: 5_000 }, { startMs: 9_000 }];

    // An intro plays with nothing lit rather than with the first line
    // highlighted for as long as the intro lasts.
    it('is -1 before the first line starts', () => {
        expect(activeLineIndex(lines, 0)).toBe(-1);
        expect(activeLineIndex(lines, 999)).toBe(-1);
    });

    it('lights a line from the instant it starts', () => {
        expect(activeLineIndex(lines, 1_000)).toBe(0);
        expect(activeLineIndex(lines, 5_000)).toBe(1);
    });

    it('holds a line until the next one starts', () => {
        expect(activeLineIndex(lines, 4_999)).toBe(0);
        expect(activeLineIndex(lines, 8_999)).toBe(1);
    });

    it('keeps the last line lit to the end of the song', () => {
        expect(activeLineIndex(lines, 9_000)).toBe(2);
        expect(activeLineIndex(lines, 600_000)).toBe(2);
    });

    it('has no line for no lyrics', () => {
        expect(activeLineIndex([], 5_000)).toBe(-1);
    });
});

describe('scrollTopForLine', () => {
    // A 600px viewport anchors at 200px. A 40px line at 500px has its centre
    // at 520, so the content scrolls by 320 to put that centre at 200.
    it('puts the centre of the line at the anchor', () => {
        expect(scrollTopForLine({ height: 40, top: 500 }, 600)).toBe(320);
    });

    // The first lines sit at the top rather than the viewport pretending it
    // can scroll above its own content.
    it('never asks to scroll above the top', () => {
        expect(scrollTopForLine({ height: 40, top: 0 }, 600)).toBe(0);
        expect(scrollTopForLine({ height: 40, top: 100 }, 600)).toBe(0);
    });

    it('is exactly zero when the line’s centre is already at the anchor', () => {
        expect(scrollTopForLine({ height: 40, top: 180 }, 600)).toBe(0);
    });
});
