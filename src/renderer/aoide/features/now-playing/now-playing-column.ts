import { z } from 'zod';

/**
 * The rules behind the Now Playing column, kept apart from the markup.
 *
 * The desktop form of the phone's Now Playing is a column that stays open
 * while you browse: artwork, title, controls, then lyrics or the queue. The
 * screen itself cannot be rendered under this repo's test runner, so every
 * number the phone's design fixes — the dimmed-line opacity, where the active
 * line sits, when the column has to give the page back — lives here where it
 * can be pinned, and the component reads it rather than restating it.
 *
 * Lives here rather than in `settings.store.ts` for the same reason as the
 * playlist-surface preference: the store cannot be imported under the test
 * runner, and the default is worth pinning.
 */
export const AoideNowPlayingColumnSchema = z.boolean();

/** On, because the column is the product; the bottom bar is what remains for people who turn it off. */
export const DEFAULT_AOIDE_NOW_PLAYING_COLUMN = true;

/**
 * Below this window width the column collapses and the page has the width.
 *
 * A browse page beside a 320px column needs room for at least one row of
 * album cards; under about 1100px it does not have it, and a column that
 * squeezes the library into a strip is worse than no column.
 */
export const COLUMN_MIN_WINDOW_WIDTH = 1100;

/** The media query the column watches, so the CSS and the JS ask the same question. */
export const COLUMN_MEDIA_QUERY = `(min-width: ${COLUMN_MIN_WINDOW_WIDTH}px)`;

export const showsNowPlayingColumn = (enabled: boolean, windowIsWide: boolean): boolean =>
    enabled && windowIsWide;

/**
 * Every lyric line but the active one, on the phone: secondary colour at 45%.
 * The active line is primary colour at full opacity.
 */
export const INACTIVE_LINE_OPACITY = 0.45;

/** Where the active line is kept: a third of the way down the viewport. */
export const ACTIVE_LINE_ANCHOR = 1 / 3;

export interface TimedLine {
    startMs: number;
}

/**
 * Which line is current at `timeMs`: the last one that has started.
 *
 * -1 before the first line, so an intro plays with nothing highlighted rather
 * than with the first line lit for thirty seconds before it is sung. Lines are
 * in the order the LRC gave them, which is start order; a line whose start is
 * later than the next line's is a broken file, not a case to be clever about.
 */
export const activeLineIndex = (lines: readonly TimedLine[], timeMs: number): number => {
    let index = -1;

    for (let i = 0; i < lines.length; i += 1) {
        if (lines[i].startMs > timeMs) break;
        index = i;
    }

    return index;
};

export interface LineBox {
    /** Height of the line, in pixels. */
    height: number;
    /** Offset of the line's top from the top of the scrolled content, in pixels. */
    top: number;
}

/**
 * The scroll offset that puts a line's centre at the anchor, clamped to zero.
 *
 * Clamped rather than allowed negative so the first lines sit at the top
 * instead of the viewport trying to scroll above its own content; the
 * browser would clamp anyway, but a helper that returns -80 is a helper whose
 * tests lie about what happens on screen.
 */
export const scrollTopForLine = (line: LineBox, viewportHeight: number): number =>
    Math.max(0, line.top + line.height / 2 - viewportHeight * ACTIVE_LINE_ANCHOR);
