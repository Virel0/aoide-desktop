import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), on: vi.fn() } }));
vi.mock('/@/main/logger', () => ({ default: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } }));

import {
    forgetTrimPlans,
    loadfileArgs,
    loadWithTrim,
    MpvLike,
    parseMpvVersion,
    rememberTrimPlans,
    takesIndexArgument,
    trimOptionsForUrl,
} from './mpv-trim';

const ID = '0123456789abcdef0123456789abcdef';
const DOWNLOAD = `https://jellyfin.local/Items/${ID}/Download?apiKey=x`;
const UNIVERSAL = `https://jellyfin.local/audio/${ID}/universal?userId=u`;

const mpv = (version: unknown = 'mpv 0.40.0'): MpvLike => ({
    command: vi.fn(async () => undefined),
    getProperty: vi.fn(async () => version),
    load: vi.fn(async () => undefined),
});

beforeEach(() => forgetTrimPlans());

describe('the plans this process holds', () => {
    it('finds a plan by the id in either of Feishin’s stream URLs', () => {
        rememberTrimPlans({ [ID]: { endSec: 312.2, startSec: 1.94 } });
        expect(trimOptionsForUrl(DOWNLOAD)).toEqual({ end: '312.2', start: '1.94' });
        expect(trimOptionsForUrl(UNIVERSAL)).toEqual({ end: '312.2', start: '1.94' });
    });

    it('matches the id as a path segment, never as a substring', () => {
        rememberTrimPlans({ [ID.slice(0, 16)]: { endSec: 312.2, startSec: 1.94 } });
        expect(trimOptionsForUrl(DOWNLOAD)).toBeUndefined();
    });

    it('forgets a track told as null, and everything on forget', () => {
        rememberTrimPlans({ [ID]: { endSec: 312.2, startSec: 1.94 } });
        rememberTrimPlans({ [ID]: null });
        expect(trimOptionsForUrl(DOWNLOAD)).toBeUndefined();

        rememberTrimPlans({ [ID]: { endSec: 312.2, startSec: 1.94 } });
        forgetTrimPlans();
        expect(trimOptionsForUrl(DOWNLOAD)).toBeUndefined();
    });
});

describe('the loadfile argument order', () => {
    it('reads the version mpv reports', () => {
        expect(parseMpvVersion('mpv 0.40.0-dirty')).toEqual([0, 40]);
        expect(parseMpvVersion('mpv v0.37.0')).toEqual([0, 37]);
        expect(parseMpvVersion(undefined)).toBeNull();
        expect(parseMpvVersion('mpv')).toBeNull();
    });

    // DOCS/man/input.rst: "Since mpv 0.38.0, an insertion index argument is
    // added as the third argument ... the third argument now needs to be set
    // to -1 if the fourth argument needs to be used."
    it('puts -1 in the index slot from 0.38 on', () => {
        expect(takesIndexArgument([0, 38])).toBe(true);
        expect(takesIndexArgument([0, 37])).toBe(false);
        expect(takesIndexArgument([1, 0])).toBe(true);
        expect(loadfileArgs([0, 40], 'u', 'append', { start: '1.94' })).toEqual([
            'u',
            'append',
            -1,
            { start: '1.94' },
        ]);
    });

    it('sends the options third on an mpv older than 0.38', () => {
        expect(loadfileArgs([0, 37], 'u', 'replace', { end: '312.2' })).toEqual([
            'u',
            'replace',
            { end: '312.2' },
        ]);
    });

    it('reads an unreadable version as a current one', () => {
        expect(takesIndexArgument(null)).toBe(true);
    });

    it('sends nothing extra without options', () => {
        expect(loadfileArgs([0, 40], 'u', 'replace')).toEqual(['u', 'replace']);
    });
});

describe('loadWithTrim', () => {
    it('is Feishin’s own load when nothing is known about the track', async () => {
        const player = mpv();
        await loadWithTrim(player, DOWNLOAD, 'replace');
        expect(player.load).toHaveBeenCalledWith(DOWNLOAD, 'replace');
        expect(player.command).not.toHaveBeenCalled();
    });

    it('sends loadfile with the file’s own start and end when they are known', async () => {
        rememberTrimPlans({ [ID]: { endSec: 312.2, startSec: 1.94 } });
        const player = mpv('mpv 0.40.0');
        await loadWithTrim(player, DOWNLOAD, 'append');
        expect(player.command).toHaveBeenCalledWith('loadfile', [
            DOWNLOAD,
            'append',
            -1,
            { end: '312.2', start: '1.94' },
        ]);
        expect(player.load).not.toHaveBeenCalled();
    });

    it('asks the version once per player', async () => {
        rememberTrimPlans({ [ID]: { endSec: 312.2, startSec: 1.94 } });
        const player = mpv('mpv 0.37.0');
        await loadWithTrim(player, DOWNLOAD, 'replace');
        await loadWithTrim(player, DOWNLOAD, 'append');
        expect(player.getProperty).toHaveBeenCalledTimes(1);
        expect(player.command).toHaveBeenLastCalledWith('loadfile', [
            DOWNLOAD,
            'append',
            { end: '312.2', start: '1.94' },
        ]);
    });

    it('does nothing for no player, as the optional chain did', async () => {
        await expect(loadWithTrim(null, DOWNLOAD, 'replace')).resolves.toBeUndefined();
    });
});
