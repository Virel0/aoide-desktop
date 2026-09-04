import { describe, expect, it } from 'vitest';

import {
    best,
    normalize,
    parsePlaylistCSV,
    parseSpotifyEmbed,
    PlaylistCSVError,
    searchTerms,
    SpotifyEmbedError,
    spotifyPlaylistId,
    verdict,
} from './playlist-import';

/**
 * One table of cases, mirrored line for line by the iOS app's `ImportTests.swift`.
 * Change a row here and change it there, or the two apps will disagree about
 * what is missing from the same playlist.
 */
const TABLE: Array<{
    accepted: boolean;
    artists: string[];
    candidateArtists: string[];
    candidateMs: null | number;
    candidateTitle: string;
    ms: null | number;
    title: string;
    why: string;
}> = [
    {
        accepted: true,
        artists: ['Radiohead'],
        candidateArtists: ['Radiohead'],
        candidateMs: 264_066,
        candidateTitle: 'Karma Police',
        ms: 264_000,
        title: 'Karma Police',
        why: 'plain equal',
    },
    {
        accepted: true,
        artists: ['Radiohead'],
        candidateArtists: ['Radiohead'],
        candidateMs: 264_000,
        candidateTitle: 'Karma Police',
        ms: 264_000,
        title: 'Karma Police - Remastered 2009',
        why: 'dash suffix with a noise word is dropped',
    },
    {
        accepted: true,
        artists: ['Beyoncé', 'JAY-Z'],
        candidateArtists: ['Beyonce'],
        candidateMs: 235_000,
        candidateTitle: 'Crazy In Love',
        ms: 236_000,
        title: 'Crazy in Love (feat. Jay-Z)',
        why: 'feat group dropped, diacritics folded, any artist pair',
    },
    {
        accepted: true,
        artists: ['Oasis'],
        candidateArtists: ['Oasis'],
        candidateMs: 300_000,
        candidateTitle: "(What's The Story) Morning Glory?",
        ms: 300_000,
        title: "(What's the Story) Morning Glory?",
        why: 'a bracket group without a noise word is kept',
    },
    {
        accepted: false,
        artists: ['Radiohead'],
        candidateArtists: ['Radiohead'],
        candidateMs: 290_000,
        candidateTitle: 'Karma Police',
        ms: 264_000,
        title: 'Karma Police',
        why: '26 seconds off is a different recording',
    },
    {
        accepted: true,
        artists: ['Radiohead'],
        candidateArtists: ['Radiohead'],
        candidateMs: 276_000,
        candidateTitle: 'Karma Police',
        ms: 264_000,
        title: 'Karma Police',
        why: '12 seconds off is a different edit, still accepted',
    },
    {
        accepted: true,
        artists: ['Radiohead'],
        candidateArtists: ['Radiohead'],
        candidateMs: 264_000,
        candidateTitle: 'Karma Police',
        ms: null,
        title: 'Karma Police',
        why: 'unknown duration on one side is not held against it',
    },
    {
        accepted: true,
        artists: ['Radiohead'],
        candidateArtists: ['Radiohead Tribute Band'],
        candidateMs: 264_000,
        candidateTitle: 'Karma Police',
        ms: 264_000,
        title: 'Karma Police',
        why: "artist words all inside the other's still count",
    },
    {
        accepted: false,
        artists: ['Radiohead'],
        candidateArtists: ['Coldplay'],
        candidateMs: 264_000,
        candidateTitle: 'Karma Police',
        ms: 264_000,
        title: 'Karma Police',
        why: 'same title, different artist',
    },
    {
        accepted: true,
        artists: ['Radiohead'],
        candidateArtists: [],
        candidateMs: 264_000,
        candidateTitle: 'Karma Police',
        ms: 264_000,
        title: 'Karma Police',
        why: 'untagged artist, exact title: trusted',
    },
    {
        accepted: true,
        artists: ['Radiohead'],
        candidateArtists: [],
        candidateMs: 264_000,
        candidateTitle: 'Karma Police',
        ms: 264_000,
        title: 'Karma Police (Live)',
        why: 'untagged artist, title exact after noise removal',
    },
    {
        accepted: false,
        artists: ['Radiohead'],
        candidateArtists: [],
        candidateMs: 264_000,
        candidateTitle: 'Karma Police',
        ms: 264_000,
        title: 'Karma Polic',
        why: 'untagged artist, inexact title: not trusted',
    },
    {
        accepted: true,
        artists: ['Led Zeppelin'],
        candidateArtists: ['Led Zeppelin'],
        candidateMs: 220_000,
        candidateTitle: 'Rock and Roll',
        ms: 220_000,
        title: 'Rock & Roll',
        why: "ampersand is 'and'",
    },
    {
        accepted: false,
        artists: ['Blur'],
        candidateArtists: ['Blur'],
        candidateMs: 122_000,
        candidateTitle: 'Song 3',
        ms: 122_000,
        title: 'Song 2',
        why: 'one of two words differs: 1/3 overlap',
    },
    {
        accepted: true,
        artists: ['Tame Impala'],
        candidateArtists: ['Tame Impala'],
        candidateMs: 216_000,
        candidateTitle: 'The Less I Know The Better - Single Version',
        ms: 216_000,
        title: 'The Less I Know the Better',
        why: 'library side carries the noise suffix',
    },
];

describe('track matching', () => {
    it.each(TABLE)('$why', (row) => {
        const result = verdict(
            { artists: row.artists, durationMs: row.ms, title: row.title },
            {
                artists: row.candidateArtists,
                durationMs: row.candidateMs,
                title: row.candidateTitle,
            },
        );
        expect(result.isAccepted, JSON.stringify(result)).toBe(row.accepted);
    });

    it.each([
        ['Crazy in Love (feat. Jay-Z)', 'crazy in love'],
        ['Karma Police - Remastered 2009', 'karma police'],
        ["(What's the Story) Morning Glory?", 'what s the story morning glory'],
        ['Beyoncé & JAY-Z', 'beyonce and jay z'],
        ['Song [Live at Wembley]', 'song'],
        ["Don't Stop Me Now - 2011 Mix", 'don t stop me now'],
        ["Ain't No Mountain High Enough", 'ain t no mountain high enough'],
        ['  Spaced   Out  ', 'spaced out'],
    ])('normalises %j as specified', (input, expected) => {
        expect(normalize(input)).toBe(expected);
    });

    it.each([
        [
            "Don't Stop Me Now - 2011 Mix",
            ["Don't Stop Me Now - 2011 Mix", "Don't Stop Me Now", 'don t stop me now', 'stop'],
        ],
        ['Karma Police', ['Karma Police', 'karma police', 'police']],
        [
            'Crazy in Love (feat. Jay-Z)',
            ['Crazy in Love (feat. Jay-Z)', 'Crazy in Love', 'crazy in love', 'crazy'],
        ],
        ['Hey', ['Hey', 'hey']],
    ])('search terms for %j start with the title as spelled and widen', (title, expected) => {
        expect(searchTerms(title)).toEqual(expected);
    });

    it('best picks the highest-scoring accepted candidate, not the first', () => {
        const track = { artists: ['Radiohead'], durationMs: 264_000, title: 'Karma Police' };
        const candidates = [
            { artists: ['Radiohead'], durationMs: 276_000, title: 'Karma Police' },
            { artists: ['Radiohead'], durationMs: 264_000, title: 'Karma Police' },
            { artists: ['Coldplay'], durationMs: 264_000, title: 'Karma Police' },
        ];
        expect(best(track, candidates)).toBe(1);
        expect(best(track, [candidates[2]])).toBeNull();
    });
});

describe('spotify links and embed page', () => {
    it.each([
        'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M?si=abc',
        'spotify:playlist:37i9dQZF1DXcBWIGoYBM5M',
        'https://open.spotify.com/embed/playlist/37i9dQZF1DXcBWIGoYBM5M',
        '  https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M  ',
    ])('reads the id out of %s', (text) => {
        expect(spotifyPlaylistId(text)).toBe('37i9dQZF1DXcBWIGoYBM5M');
    });

    it.each([
        'https://open.spotify.com/track/37i9dQZF1DXcBWIGoYBM5M',
        'https://open.spotify.com/playlist/short',
        'hello',
    ])('refuses %s', (text) => {
        expect(spotifyPlaylistId(text)).toBeNull();
    });

    const page =
        '<html><head><script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"state":{"data":{"entity":{"type":"playlist","name":"ignored","title":"Road Trip","subtitle":"Gabe","trackList":[{"uri":"spotify:track:1","title":"Karma Police","subtitle":"Radiohead","duration":264066,"isExplicit":false},{"uri":"spotify:track:2","title":"Crazy in Love (feat. Jay-Z)","subtitle":"Beyoncé, JAY-Z","duration":236000},{"uri":"spotify:track:3","title":"","subtitle":"Nobody","duration":1}]}}}}}}</script></head><body></body></html>';

    it('parses the embedded state', () => {
        const playlist = parseSpotifyEmbed(page);
        expect(playlist.name).toBe('Road Trip');
        expect(playlist.tracks).toHaveLength(2);
        expect(playlist.tracks[0]).toEqual({
            artists: ['Radiohead'],
            durationMs: 264_066,
            title: 'Karma Police',
        });
        expect(playlist.tracks[1].artists).toEqual(['Beyoncé', 'JAY-Z']);
        expect(playlist.isTruncated).toBe(false);
    });

    it('a hundred tracks means there may be more', () => {
        const rows = Array.from(
            { length: 100 },
            (_, i) => `{"title":"T${i}","subtitle":"A","duration":1000}`,
        ).join(',');
        const html = `<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"state":{"data":{"entity":{"title":"Big","trackList":[${rows}]}}}}}}</script>`;
        expect(parseSpotifyEmbed(html).isTruncated).toBe(true);
    });

    it('says so when the page has changed shape rather than returning nothing', () => {
        expect(() => parseSpotifyEmbed('<html><body>nothing</body></html>')).toThrow(
            SpotifyEmbedError,
        );
        expect(() =>
            parseSpotifyEmbed(
                '<script id="__NEXT_DATA__" type="application/json">{"props":{}}</script>',
            ),
        ).toThrow('no entity at props.pageProps.state.data.entity');
    });
});

describe('playlist CSV', () => {
    it('reads an Exportify file, quotes and all', () => {
        const csv = [
            'Track URI,Track Name,Artist URI(s),Artist Name(s),Album URI,Album Name,Track Duration (ms),ISRC',
            'spotify:track:1,"Crazy in Love (feat. Jay-Z)",x,"Beyoncé, JAY-Z",y,Dangerously in Love,236000,USSM10301234',
            'spotify:track:2,"Say ""Hi""",x,Someone,y,"Album, with comma",1000,',
        ].join('\n');
        const playlist = parsePlaylistCSV(csv, 'From file');
        expect(playlist.name).toBe('From file');
        expect(playlist.tracks).toHaveLength(2);
        expect(playlist.tracks[0]).toEqual({
            album: 'Dangerously in Love',
            artists: ['Beyoncé', 'JAY-Z'],
            durationMs: 236_000,
            isrc: 'USSM10301234',
            title: 'Crazy in Love (feat. Jay-Z)',
        });
        expect(playlist.tracks[1].title).toBe('Say "Hi"');
        expect(playlist.tracks[1].album).toBe('Album, with comma');
        expect(playlist.tracks[1].isrc).toBeNull();
    });

    it("tolerates other tools' headers and mm:ss lengths", () => {
        const playlist = parsePlaylistCSV(
            'Title,Artist,Album,Duration\r\nKarma Police,Radiohead,OK Computer,4:24\r\n',
            'x',
        );
        expect(playlist.tracks).toEqual([
            {
                album: 'OK Computer',
                artists: ['Radiohead'],
                durationMs: 264_000,
                isrc: null,
                title: 'Karma Police',
            },
        ]);
    });

    it('a byte-order mark does not hide the first header', () => {
        const playlist = parsePlaylistCSV('\uFEFFTitle,Artist\nKarma Police,Radiohead\n', 'x');
        expect(playlist.tracks.map((track) => track.title)).toEqual(['Karma Police']);
    });

    it('refuses a file with no title column', () => {
        expect(() => parsePlaylistCSV('a,b\n1,2\n', 'x')).toThrow(PlaylistCSVError);
    });
});
