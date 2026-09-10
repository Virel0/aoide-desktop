import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), on: vi.fn() } }));

import { forgetGains, gainOptionsForUrl, knownGains, rememberGains } from './mpv-gain';

const ID = '0123456789abcdef0123456789abcdef';
const DOWNLOAD = `https://jellyfin.local/Items/${ID}/Download?apiKey=x`;
const UNIVERSAL = `https://jellyfin.local/audio/${ID}/universal?userId=u`;

beforeEach(() => forgetGains());

describe('the gains this process holds', () => {
    it('finds a gain by the id in either of Feishin’s stream URLs', () => {
        rememberGains({ [ID]: -8.3 });
        expect(gainOptionsForUrl(DOWNLOAD)).toEqual({ af: 'volume=-8.3dB' });
        expect(gainOptionsForUrl(UNIVERSAL)).toEqual({ af: 'volume=-8.3dB' });
    });

    it('matches the id as a path segment, never as a substring', () => {
        rememberGains({ [ID.slice(0, 16)]: -8.3 });
        expect(gainOptionsForUrl(DOWNLOAD)).toEqual({});
    });

    it('says nothing about a track it has never been told about', () => {
        expect(gainOptionsForUrl(DOWNLOAD)).toEqual({});
    });

    // A stale gain would attenuate a track that was measured as already right.
    it('forgets a track told as null, and everything on forget', () => {
        rememberGains({ [ID]: -8.3 });
        rememberGains({ [ID]: null });
        expect(gainOptionsForUrl(DOWNLOAD)).toEqual({});

        rememberGains({ [ID]: -8.3 });
        forgetGains();
        expect(gainOptionsForUrl(DOWNLOAD)).toEqual({});
    });

    // The value crosses a process boundary, so it arrives as whatever the other
    // side sent. `volume=NaNdB` is a filter chain mpv refuses, which would fail
    // the whole load rather than the gain.
    it('refuses a value that is not a finite number', () => {
        rememberGains({ [ID]: Number.NaN as unknown as number });
        expect(knownGains().has(ID)).toBe(false);
        rememberGains({ [ID]: '-8.3' as unknown as number });
        expect(knownGains().has(ID)).toBe(false);
    });
});
