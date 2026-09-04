/**
 * Importing a playlist from somewhere else, and deciding what the library has.
 *
 * The rules in `verdict` are a **specification shared with the iOS app**, which
 * carries the same rules in Swift (`Packages/JellyfinKit/.../TrackMatcher.swift`).
 * Both are checked against one table of cases (`playlist-import.test.ts`,
 * `ImportTests.swift`): a track that matches on the phone must match on the
 * desk, or an import made on one would disagree with the other about what is
 * missing.
 *
 * Normalisation, in order:
 * 1. lower-case, then fold diacritics ("Beyoncé" → "beyonce");
 * 2. "&" → " and ";
 * 3. drop a bracketed group — `(…)` or `[…]` — whose text contains a noise word;
 * 4. drop a ` - …` suffix whose text contains a noise word;
 * 5. keep only letters, digits and spaces; collapse runs of spaces; trim.
 *
 * Scores (0…1), each from the two normalised strings' word sets: equal → 1;
 * one's words all inside the other's → 0.9; otherwise the Jaccard overlap.
 * Title uses that; artist uses the best over every pair of imported artist ×
 * library artist. Duration, when both known: within 5 s → 1; within 15 s →
 * 0.8; else 0. Unknown on either side → 0.9.
 *
 * Accepted when title ≥ 0.75, artist ≥ 0.7 and duration > 0. A side with no
 * artist at all is accepted only when the title is exact. The overall score,
 * used only to rank accepted candidates, is 0.5·title + 0.35·artist +
 * 0.15·duration.
 */

export interface Candidate {
    artists: string[];
    durationMs?: null | number;
    title: string;
}

export interface ImportedPlaylist {
    /** The source is known to hold more than it handed over. */
    isTruncated: boolean;
    name: string;
    tracks: ImportedTrack[];
}

export interface ImportedTrack {
    album?: null | string;
    artists: string[];
    durationMs?: null | number;
    isrc?: null | string;
    title: string;
}

export interface Verdict {
    artist: number;
    duration: number;
    isAccepted: boolean;
    overall: number;
    title: number;
}

export const TITLE_THRESHOLD = 0.75;
export const ARTIST_THRESHOLD = 0.7;
export const CLOSE_DURATION_MS = 5_000;
export const LOOSE_DURATION_MS = 15_000;

const NOISE_WORDS = new Set([
    'acoustic',
    'anniversary',
    'bonus',
    'clean',
    'deluxe',
    'demo',
    'edit',
    'edition',
    'explicit',
    'feat',
    'featuring',
    'from',
    'ft',
    'instrumental',
    'live',
    'mix',
    'mono',
    'original',
    'radio',
    'remaster',
    'remastered',
    'remix',
    'single',
    'stereo',
    'version',
    'with',
    'extended',
    'reissue',
]);

const containsNoise = (text: string): boolean =>
    text
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter(Boolean)
        .some((word) => NOISE_WORDS.has(word));

const stripNoisyGroups = (text: string, open: string, close: string): string => {
    let result = text;
    for (;;) {
        const start = result.indexOf(open);
        if (start < 0) return result;
        const end = result.indexOf(close, start);
        if (end < 0) return result;
        const inside = result.slice(start + 1, end);
        result = containsNoise(inside)
            ? result.slice(0, start) + result.slice(end + 1)
            : // A group worth keeping stays; only its brackets go.
              `${result.slice(0, start)} ${inside} ${result.slice(end + 1)}`;
    }
};

const stripNoisySuffix = (text: string): string => {
    const at = text.indexOf(' - ');
    if (at < 0) return text;
    return containsNoise(text.slice(at + 3)) ? text.slice(0, at) : text;
};

export const normalize = (text: string): string => {
    let s = text.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/&/g, ' and ');
    s = stripNoisyGroups(s, '(', ')');
    s = stripNoisyGroups(s, '[', ']');
    s = stripNoisySuffix(s);
    return s
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .split(' ')
        .filter(Boolean)
        .join(' ');
};

/** The title without its noise groups and suffix, spelling otherwise untouched. */
export const stripNoise = (title: string): string => {
    let s = stripNoisyGroups(title, '(', ')');
    s = stripNoisyGroups(s, '[', ']');
    s = stripNoisySuffix(s);
    return s.split(/\s+/).filter(Boolean).join(' ');
};

/**
 * Phrases to search the library with, most specific first.
 *
 * The server matches names as typed, so it must be asked in the title's own
 * spelling: the *normalised* form — "don t stop me now" — matches nothing,
 * which is how an import once reported a library's own songs as missing. The
 * search widens step by step: the title as given; the title with the noise
 * stripped but punctuation intact; the normalised words; and finally the single
 * longest word, for the case where the two sides spell punctuation differently.
 * The matcher judges whatever comes back, so a wide net costs only a request.
 */
export const searchTerms = (title: string): string[] => {
    const terms: string[] = [];
    const add = (term: string) => {
        const trimmed = term.trim();
        if (trimmed.length > 0 && !terms.includes(trimmed)) terms.push(trimmed);
    };
    add(title);
    add(stripNoise(title));
    const normalized = normalize(title);
    add(normalized);
    const longest = normalized
        .split(' ')
        .filter(Boolean)
        .reduce((best, word) => (word.length > best.length ? word : best), '');
    if (longest.length >= 4) add(longest);
    return terms;
};

export const similarity = (a: string, b: string): number => {
    if (a === b) return a.length === 0 ? 0 : 1;
    const wordsA = new Set(a.split(' ').filter(Boolean));
    const wordsB = new Set(b.split(' ').filter(Boolean));
    if (wordsA.size === 0 || wordsB.size === 0) return 0;
    const subset = (x: Set<string>, y: Set<string>) => [...x].every((word) => y.has(word));
    if (subset(wordsA, wordsB) || subset(wordsB, wordsA)) return 0.9;
    const shared = [...wordsA].filter((word) => wordsB.has(word)).length;
    const union = new Set([...wordsA, ...wordsB]).size;
    return shared / union;
};

export const verdict = (track: ImportedTrack, candidate: Candidate): Verdict => {
    const title = similarity(normalize(track.title), normalize(candidate.title));

    let artist: number;
    if (candidate.artists.length === 0 || track.artists.length === 0) {
        artist = 0.5;
    } else {
        const ours = track.artists.map(normalize);
        const theirs = candidate.artists.map(normalize);
        artist = Math.max(...ours.flatMap((a) => theirs.map((b) => similarity(a, b))));
    }

    let duration: number;
    if (track.durationMs != null && candidate.durationMs != null) {
        const delta = Math.abs(track.durationMs - candidate.durationMs);
        duration = delta <= CLOSE_DURATION_MS ? 1 : delta <= LOOSE_DURATION_MS ? 0.8 : 0;
    } else {
        duration = 0.9;
    }

    // With no artist to compare, only an exact title is trusted.
    const artistAccepted =
        candidate.artists.length === 0 || track.artists.length === 0
            ? title === 1
            : artist >= ARTIST_THRESHOLD;
    const isAccepted = title >= TITLE_THRESHOLD && artistAccepted && duration > 0;

    return {
        artist,
        duration,
        isAccepted,
        overall: 0.5 * title + 0.35 * artist + 0.15 * duration,
        title,
    };
};

/** The index of the best accepted candidate, or null when none is the track. */
export const best = (track: ImportedTrack, candidates: Candidate[]): null | number => {
    let bestIndex: null | number = null;
    let bestScore = -1;
    candidates.forEach((candidate, index) => {
        const result = verdict(track, candidate);
        if (!result.isAccepted || result.overall <= bestScore) return;
        bestScore = result.overall;
        bestIndex = index;
    });
    return bestIndex;
};

// ---------------------------------------------------------------------------
// Spotify

/** The embed page never lists more than this many tracks, whatever the playlist holds. */
export const SPOTIFY_EMBED_TRACK_LIMIT = 100;

/**
 * The 22-character id out of whatever somebody pasted — a share link, a
 * `spotify:playlist:` URI or an embed link — or null.
 */
export const spotifyPlaylistId = (text: string): null | string => {
    const match =
        /(?:spotify:playlist:|open\.spotify\.com\/(?:embed\/)?playlist\/)([A-Za-z0-9]{22})/.exec(
            text.trim(),
        );
    return match?.[1] ?? null;
};

export const spotifyEmbedUrl = (playlistId: string): string =>
    `https://open.spotify.com/embed/playlist/${playlistId}`;

export class SpotifyEmbedError extends Error {
    constructor(
        public readonly kind: 'noEmbeddedState' | 'unexpectedShape',
        detail?: string,
    ) {
        super(detail ?? kind);
        this.name = 'SpotifyEmbedError';
    }
}

/**
 * The track list out of Spotify's embed page.
 *
 * The public playlist page renders on the client and carries no data; the embed
 * page ships its state in a `__NEXT_DATA__` script. Undocumented, so this fails
 * loudly: a shape change must read as "Spotify changed its page", never as an
 * empty playlist.
 */
export const parseSpotifyEmbed = (html: string): ImportedPlaylist => {
    const open = '<script id="__NEXT_DATA__" type="application/json">';
    const start = html.indexOf(open);
    if (start < 0) throw new SpotifyEmbedError('noEmbeddedState');
    const end = html.indexOf('</script>', start);
    if (end < 0) throw new SpotifyEmbedError('noEmbeddedState');

    let root: unknown;
    try {
        root = JSON.parse(html.slice(start + open.length, end));
    } catch {
        throw new SpotifyEmbedError('unexpectedShape', 'state is not JSON');
    }

    const entity = dig(root, ['props', 'pageProps', 'state', 'data', 'entity']);
    if (!isRecord(entity)) {
        throw new SpotifyEmbedError(
            'unexpectedShape',
            'no entity at props.pageProps.state.data.entity',
        );
    }
    const list = entity.trackList;
    if (!Array.isArray(list)) {
        throw new SpotifyEmbedError('unexpectedShape', 'entity has no trackList');
    }

    const tracks: ImportedTrack[] = [];
    for (const row of list) {
        if (!isRecord(row) || typeof row.title !== 'string' || row.title.length === 0) continue;
        // Artists arrive as one comma-joined string. A name with a comma in it
        // splits wrong, and there is nothing in the page to tell those apart.
        const subtitle = typeof row.subtitle === 'string' ? row.subtitle : '';
        tracks.push({
            artists: subtitle
                .split(',')
                .map((name) => name.trim())
                .filter(Boolean),
            durationMs: typeof row.duration === 'number' ? Math.trunc(row.duration) : null,
            title: row.title,
        });
    }

    const name =
        typeof entity.title === 'string' && entity.title.length > 0
            ? entity.title
            : 'Spotify playlist';
    return { isTruncated: list.length >= SPOTIFY_EMBED_TRACK_LIMIT, name, tracks };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const dig = (value: unknown, keys: string[]): unknown => {
    let current: unknown = value;
    for (const key of keys) {
        if (!isRecord(current)) return undefined;
        current = current[key];
    }
    return current;
};

// ---------------------------------------------------------------------------
// CSV exports

export class PlaylistCSVError extends Error {
    constructor(public readonly kind: 'empty' | 'noTitleColumn') {
        super(kind);
        this.name = 'PlaylistCSVError';
    }
}

const TITLE_HEADERS = ['track name', 'title', 'track', 'name', 'song'];
const ARTIST_HEADERS = ['artist name(s)', 'artist name', 'artist', 'artists', 'artist(s)'];
const ALBUM_HEADERS = ['album name', 'album'];
const DURATION_HEADERS = ['track duration (ms)', 'duration (ms)', 'duration_ms', 'duration'];
const ISRC_HEADERS = ['isrc'];

/**
 * A playlist out of a CSV export — Exportify's by default, with enough
 * tolerance for the other tools' column names.
 */
export const parsePlaylistCSV = (text: string, name: string): ImportedPlaylist => {
    // Some exporters lead with a byte-order mark, which would glue itself to the
    // first header and hide it from the aliases.
    const clean = text.startsWith('\uFEFF') ? text.slice(1) : text;
    const rows = csvRows(clean).filter((row) => row.some((cell) => cell.length > 0));
    const header = rows[0];
    if (!header) throw new PlaylistCSVError('empty');

    const columns = header.map((cell) => cell.trim().toLowerCase());
    const indexOf = (names: string[]): number => {
        for (const candidate of names) {
            const found = columns.indexOf(candidate);
            if (found >= 0) return found;
        }
        return -1;
    };

    const title = indexOf(TITLE_HEADERS);
    if (title < 0) throw new PlaylistCSVError('noTitleColumn');
    const artist = indexOf(ARTIST_HEADERS);
    const album = indexOf(ALBUM_HEADERS);
    const duration = indexOf(DURATION_HEADERS);
    const isrc = indexOf(ISRC_HEADERS);

    const tracks: ImportedTrack[] = [];
    for (const row of rows.slice(1)) {
        const cell = (column: number): null | string => {
            if (column < 0 || column >= row.length) return null;
            const value = row[column].trim();
            return value.length > 0 ? value : null;
        };
        const trackTitle = cell(title);
        if (!trackTitle) continue;
        const rawDuration = cell(duration);
        let durationMs: null | number = null;
        if (rawDuration) {
            // Exportify writes milliseconds; a hand-made sheet may write mm:ss.
            if (/^\d+$/.test(rawDuration)) {
                durationMs = Number(rawDuration);
            } else {
                const parts = rawDuration.split(':').map(Number);
                if (parts.length === 2 && parts.every(Number.isInteger)) {
                    durationMs = (parts[0] * 60 + parts[1]) * 1000;
                }
            }
        }
        tracks.push({
            album: cell(album),
            artists: (cell(artist) ?? '')
                .split(',')
                .map((value) => value.trim())
                .filter(Boolean),
            durationMs,
            isrc: cell(isrc),
            title: trackTitle,
        });
    }

    return { isTruncated: false, name, tracks };
};

/** Just enough of RFC 4180: quoted fields, doubled quotes, newlines inside quotes. */
export const csvRows = (text: string): string[][] => {
    const rows: string[][] = [];
    let row: string[] = [];
    let field = '';
    let quoted = false;

    for (let i = 0; i < text.length; i += 1) {
        const character = text[i];
        if (quoted) {
            if (character === '"') {
                if (text[i + 1] === '"') {
                    field += '"';
                    i += 1;
                } else {
                    quoted = false;
                }
            } else {
                field += character;
            }
            continue;
        }
        if (character === '"' && field.length === 0) {
            quoted = true;
        } else if (character === ',') {
            row.push(field);
            field = '';
        } else if (character === '\r') {
            // dropped
        } else if (character === '\n') {
            row.push(field);
            rows.push(row);
            row = [];
            field = '';
        } else {
            field += character;
        }
    }
    if (field.length > 0 || row.length > 0) {
        row.push(field);
        rows.push(row);
    }
    return rows;
};
