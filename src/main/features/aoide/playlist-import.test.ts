import { describe, expect, it, vi } from 'vitest';

import { BROWSER_USER_AGENT, fetchSpotifyPlaylist } from './playlist-import';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));

const page = (tracks: string) =>
    `<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"state":{"data":{"entity":{"title":"Road Trip","trackList":[${tracks}]}}}}}}</script>`;

const respond = (status: number, body: string) => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
});

describe('fetchSpotifyPlaylist', () => {
    it('reads the playlist off the embed page, introducing itself as a browser', async () => {
        const fetchPage = vi.fn(async () =>
            respond(200, page('{"title":"Karma Police","subtitle":"Radiohead","duration":264000}')),
        );

        const outcome = await fetchSpotifyPlaylist(
            'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M?si=x',
            fetchPage,
        );

        expect(outcome).toEqual({
            playlist: {
                isTruncated: false,
                name: 'Road Trip',
                tracks: [{ artists: ['Radiohead'], durationMs: 264_000, title: 'Karma Police' }],
            },
        });
        expect(fetchPage).toHaveBeenCalledWith(
            'https://open.spotify.com/embed/playlist/37i9dQZF1DXcBWIGoYBM5M',
            { 'User-Agent': BROWSER_USER_AGENT },
        );
    });

    it('does not ask at all for something that is not a playlist link', async () => {
        const fetchPage = vi.fn();
        expect(await fetchSpotifyPlaylist('hello', fetchPage)).toEqual({ reason: 'notALink' });
        expect(fetchPage).not.toHaveBeenCalled();
    });

    it('distinguishes a refused page from a changed one from no network', async () => {
        expect(
            await fetchSpotifyPlaylist('spotify:playlist:37i9dQZF1DXcBWIGoYBM5M', async () =>
                respond(404, ''),
            ),
        ).toEqual({ detail: '404', reason: 'unavailable' });

        expect(
            await fetchSpotifyPlaylist('spotify:playlist:37i9dQZF1DXcBWIGoYBM5M', async () =>
                respond(200, '<html>no state</html>'),
            ),
        ).toMatchObject({ reason: 'pageChanged' });

        expect(
            await fetchSpotifyPlaylist('spotify:playlist:37i9dQZF1DXcBWIGoYBM5M', async () => {
                throw new Error('offline');
            }),
        ).toEqual({ detail: 'offline', reason: 'network' });
    });
});
