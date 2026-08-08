import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { TrackInput } from './playlists';

import { CurationStore } from './curation-store';
import { CurationDatabase, openCurationDatabase } from './database';
import { contentKeyFor, Playlists } from './playlists';

let database: CurationDatabase;
let store: CurationStore;
let playlists: Playlists;

beforeEach(() => {
    database = openCurationDatabase(':memory:');
    store = new CurationStore(database);
    playlists = new Playlists(database, store);
});

afterEach(() => database.close());

const track = (n: number, overrides: Partial<TrackInput> = {}): TrackInput => ({
    album: `Album ${n}`,
    artist: `Artist ${n}`,
    durationMs: 200_000 + n,
    jellyfinId: `jf-${n}`,
    title: `Track ${n}`,
    ...overrides,
});

/** Rows as SQLite holds them, deleted ones included — what a soft delete has to leave behind. */
const rawPlaylists = () =>
    database.db.prepare('SELECT * FROM playlists').all() as Array<Record<string, unknown>>;

const rawItems = () =>
    database.db.prepare('SELECT * FROM playlist_items').all() as Array<Record<string, unknown>>;

const positionsOf = (playlistId: string) => playlists.items(playlistId).map((i) => i.position);

const titlesOf = (playlistId: string) => playlists.items(playlistId).map((i) => i.title);

describe('creating and listing', () => {
    it('appends each new playlist after the last', () => {
        const first = playlists.create('Driving');
        const second = playlists.create('Cooking');
        const third = playlists.create('Sleeping');

        expect(playlists.list().map((p) => p.name)).toEqual(['Driving', 'Cooking', 'Sleeping']);
        expect(first.sortIndex < second.sortIndex).toBe(true);
        expect(second.sortIndex < third.sortIndex).toBe(true);
    });

    it('counts only live entries', () => {
        const list = playlists.create('Driving');
        const added = playlists.addTracks(list.id, [track(1), track(2), track(3)]);
        playlists.removeItem(added[1].id);

        expect(playlists.list()[0].trackCount).toBe(2);
        expect(playlists.get(list.id)?.trackCount).toBe(2);
    });

    it('reports isSmart as a boolean rather than the 0 SQLite holds', () => {
        const list = playlists.create('Driving');
        expect(playlists.get(list.id)?.isSmart).toBe(false);
    });

    it('refuses a folder that does not exist, rather than hiding the playlist in it', () => {
        expect(() => playlists.create('Driving', { folderId: 'nope' })).toThrow(/No folder/);
    });

    it('records an op for every write', () => {
        playlists.create('Driving');
        const ops = store.pendingOps();

        expect(ops).toHaveLength(1);
        expect(ops[0].entity).toBe('playlists');
        expect(ops[0].payload.name).toBe('Driving');
        // Read back from the row, so a column with a DEFAULT still travels — the
        // phone's Playlist declares isSmart non-optional and quarantines an op
        // that omits it.
        expect(ops[0].payload.isSmart).toBe(false);
    });
});

describe('adding tracks', () => {
    it('gives a batch ascending positions without walking the list per track', () => {
        const list = playlists.create('Driving');
        const tracks = Array.from({ length: 600 }, (_unused, n) => track(n));

        const added = playlists.addTracks(list.id, tracks);
        const positions = added.map((item) => item.position);

        expect(positions).toHaveLength(600);
        expect([...positions].sort()).toEqual(positions);
        expect(new Set(positions).size).toBe(600);
        // Incrementing, not bisecting. Bisecting towards the end reached
        // 167-character keys over a thousand appends on iOS; every character of
        // that is stored on every device and pushed through every sync forever.
        // This measures 11 for six hundred; the bound is only there to catch a
        // change that starts halving the remaining space again.
        expect(Math.max(...positions.map((p) => p.length))).toBeLessThan(20);
    });

    it('appends after what is already there', () => {
        const list = playlists.create('Driving');
        playlists.addTracks(list.id, [track(1), track(2)]);
        playlists.addTracks(list.id, [track(3)]);

        expect(titlesOf(list.id)).toEqual(['Track 1', 'Track 2', 'Track 3']);
    });

    it('adds a track that is already present again rather than skipping it', () => {
        const list = playlists.create('Driving');
        playlists.addTracks(list.id, [track(1)]);
        playlists.addTracks(list.id, [track(1)]);

        expect(playlists.items(list.id)).toHaveLength(2);
    });

    it('caches the metadata so the playlist can be drawn without Jellyfin', () => {
        const list = playlists.create('Driving');
        playlists.addTracks(list.id, [
            track(1, { albumId: 'album-1', genres: ['Shoegaze'], year: 1991 }),
        ]);

        const [item] = playlists.items(list.id);
        expect(item.title).toBe('Track 1');
        expect(item.artist).toBe('Artist 1');
        expect(item.albumId).toBe('album-1');
        expect(item.genres).toEqual(['Shoegaze']);
        expect(item.year).toBe(1991);
    });

    it('keeps an entry whose track this device has never seen', () => {
        // What arrives from the phone: an item for a track that is not in this
        // device's cache. An inner join would shorten the playlist silently.
        const list = playlists.create('Driving');
        store.applyRemote({
            createdAt: Date.now(),
            entity: 'playlist_items',
            entityId: 'remote-item',
            operation: 'upsert',
            opId: randomUUID(),
            payload: {
                contentKey: 'someone|else|track|200',
                deleted: false,
                id: 'remote-item',
                jellyfinId: 'jf-unknown',
                originDevice: 'phone',
                playlistId: list.id,
                position: 'a1',
                updatedAt: Date.now(),
            },
        });

        const [item] = playlists.items(list.id);
        expect(item.id).toBe('remote-item');
        expect(item.title).toBeNull();
        expect(item.genres).toEqual([]);
    });

    it('takes a content key it is given and computes one when it is not', () => {
        const list = playlists.create('Driving');
        playlists.addTracks(list.id, [
            track(1, { contentKey: 'given' }),
            track(2, { album: 'Post', artist: 'Björk', durationMs: 234_100, title: 'Army of Me' }),
        ]);

        const items = playlists.items(list.id);
        expect(items[0].contentKey).toBe('given');
        expect(items[1].contentKey).toBe('bjork|post|army of me|234');
    });
});

describe('content keys', () => {
    // The phone's own fixture, from CurationStoreTests.contentKey. Two clients
    // that normalise differently relink to different tracks after a rescan, and
    // neither one can tell.
    it('matches the phone on the same track described two ways', () => {
        const one = contentKeyFor({
            album: 'Post',
            artist: 'Björk',
            durationMs: 234_100,
            title: 'Army of Me',
        });
        const other = contentKeyFor({
            album: 'post',
            artist: '  bjork ',
            durationMs: 234_400,
            title: 'ARMY OF ME',
        });

        expect(one).toBe(other);
        expect(one).toBe('bjork|post|army of me|234');
    });

    it('distinguishes two recordings of the same length', () => {
        const army = contentKeyFor({
            album: 'Post',
            artist: 'Björk',
            durationMs: 234_100,
            title: 'Army of Me',
        });
        const hyperballad = contentKeyFor({
            album: 'Post',
            artist: 'Björk',
            durationMs: 234_100,
            title: 'Hyperballad',
        });

        expect(army).not.toBe(hyperballad);
    });

    it('treats an unknown duration as zero seconds rather than throwing', () => {
        expect(contentKeyFor({ album: 'Post', artist: 'Björk', title: 'Army of Me' })).toBe(
            'bjork|post|army of me|0',
        );
    });
});

describe('moving an entry', () => {
    const fourTracks = () => {
        const list = playlists.create('Driving');
        playlists.addTracks(list.id, [track(1), track(2), track(3), track(4)]);
        return list.id;
    };

    it('reorders, and writes exactly one row', () => {
        const listId = fourTracks();
        const items = playlists.items(listId);
        const before = positionsOf(listId);

        store.markSynced(store.pendingOps().map((op) => op.opId));
        const moved = playlists.moveItem(items[3].id, {
            afterId: items[0].id,
            beforeId: items[1].id,
        });

        expect(titlesOf(listId)).toEqual(['Track 1', 'Track 4', 'Track 2', 'Track 3']);

        const ops = store.pendingOps();
        expect(ops).toHaveLength(1);
        expect(ops[0].entityId).toBe(moved.id);

        // The neighbours are untouched. Renumbering them would hand back exactly
        // what the fractional index was chosen to buy.
        const after = new Map(playlists.items(listId).map((i) => [i.id, i.position]));
        items.slice(0, 3).forEach((item, index) => {
            expect(after.get(item.id)).toBe(before[index]);
        });
    });

    it('moves to the top and to the bottom', () => {
        const listId = fourTracks();
        const items = playlists.items(listId);

        playlists.moveItem(items[2].id, { afterId: null, beforeId: items[0].id });
        expect(titlesOf(listId)).toEqual(['Track 3', 'Track 1', 'Track 2', 'Track 4']);

        playlists.moveItem(items[0].id, { afterId: items[3].id, beforeId: null });
        expect(titlesOf(listId)).toEqual(['Track 3', 'Track 2', 'Track 4', 'Track 1']);
    });

    it('writes nothing when the entry is already there', () => {
        const listId = fourTracks();
        const items = playlists.items(listId);
        store.markSynced(store.pendingOps().map((op) => op.opId));

        // A drag that lands back where it started. An op here is one every other
        // device has to merge for a change that did not happen.
        playlists.moveItem(items[1].id, { afterId: items[0].id, beforeId: items[2].id });
        expect(store.pendingOps()).toHaveLength(0);

        // And the degenerate case: no neighbours at all names no position.
        playlists.moveItem(items[1].id, { afterId: null, beforeId: null });
        expect(store.pendingOps()).toHaveLength(0);
        expect(titlesOf(listId)).toEqual(['Track 1', 'Track 2', 'Track 3', 'Track 4']);
    });

    it('refuses neighbours that are not in the same playlist', () => {
        const listId = fourTracks();
        const other = playlists.create('Cooking');
        const stranger = playlists.addTracks(other.id, [track(9)])[0];
        const items = playlists.items(listId);

        expect(() =>
            playlists.moveItem(items[0].id, { afterId: stranger.id, beforeId: null }),
        ).toThrow(/not in playlist/);
        expect(() =>
            playlists.moveItem(items[0].id, { afterId: items[0].id, beforeId: null }),
        ).toThrow(/itself/);
    });
});

describe('deleting', () => {
    it('leaves the row behind when an entry goes', () => {
        const list = playlists.create('Driving');
        const [first, second] = playlists.addTracks(list.id, [track(1), track(2)]);

        playlists.removeItem(first.id);

        expect(playlists.items(list.id).map((i) => i.id)).toEqual([second.id]);
        // A hard delete cannot be synced: the absence of a row is
        // indistinguishable from never having seen it.
        const raw = rawItems().find((row) => row.id === first.id);
        expect(raw).toBeDefined();
        expect(raw?.deleted).toBe(1);

        const op = store.pendingOps().at(-1);
        expect(op?.operation).toBe('delete');
        expect(op?.payload.deleted).toBe(true);
    });

    it('takes the entries with it, and leaves every row behind', () => {
        const list = playlists.create('Driving');
        playlists.addTracks(list.id, [track(1), track(2)]);

        playlists.remove(list.id);

        expect(playlists.list()).toEqual([]);
        expect(playlists.get(list.id)).toBeUndefined();
        expect(rawPlaylists()).toHaveLength(1);
        expect(rawPlaylists()[0].deleted).toBe(1);
        // Entries left live would be rewritten by the next relink pass, and a
        // device merging the delete late would find the playlist whole again.
        expect(rawItems().every((row) => row.deleted === 1)).toBe(true);
    });

    it('does not mint a second op for a second delete', () => {
        const list = playlists.create('Driving');
        playlists.remove(list.id);
        store.markSynced(store.pendingOps().map((op) => op.opId));

        playlists.remove(list.id);
        expect(store.pendingOps()).toHaveLength(0);
    });
});

describe('renaming', () => {
    it('keeps the older stamps of untouched fields, so a concurrent edit survives', () => {
        // The failure this guards: recording only the changed field produces a
        // stamp map that says nothing beyond the row's updatedAt, so none is
        // written, so the receiving device treats the rename as a full-row write
        // and drops a note someone else was editing. Nothing about that is
        // visible from this side.
        const list = playlists.create('Driving', { notes: 'For the M6' });
        store.markSynced(store.pendingOps().map((op) => op.opId));

        playlists.rename(list.id, 'Driving north');

        const [op] = store.pendingOps();
        const stamps = op.payload.fieldUpdatedAt as Record<string, number>;
        expect(stamps).toBeDefined();
        expect(stamps.name).toBeGreaterThan(stamps.notes);
        expect(op.payload.name).toBe('Driving north');
        expect(op.payload.notes).toBe('For the M6');
    });

    it('sets and clears the notes', () => {
        const list = playlists.create('Driving');
        expect(playlists.setNotes(list.id, 'For the M6').notes).toBe('For the M6');
        expect(playlists.setNotes(list.id, null).notes).toBeNull();
    });

    it('refuses a playlist that has been deleted', () => {
        const list = playlists.create('Driving');
        playlists.remove(list.id);
        expect(() => playlists.rename(list.id, 'Driving north')).toThrow(/No playlist/);
    });
});

describe('importing from Jellyfin', () => {
    it('matches a re-import on the source id, never on the name', () => {
        // The sidecar's bug: two playlists each became two after a re-import.
        // These two share a name and differ only in where they came from, which
        // is exactly the pair name matching gets wrong.
        const first = playlists.importFromJellyfin({
            name: 'Favourites',
            sourceJellyfinId: 'jf-playlist-1',
            tracks: [track(1)],
        });
        const second = playlists.importFromJellyfin({
            name: 'Favourites',
            sourceJellyfinId: 'jf-playlist-2',
            tracks: [track(2)],
        });

        expect(first.created).toBe(true);
        expect(second.created).toBe(true);
        expect(first.playlistId).not.toBe(second.playlistId);

        // Renamed on the server since the first import. A name match would now
        // find nothing and make a third playlist.
        const again = playlists.importFromJellyfin({
            name: 'Favourites (2024)',
            sourceJellyfinId: 'jf-playlist-1',
            tracks: [track(1), track(3)],
        });

        expect(again.created).toBe(false);
        expect(again.playlistId).toBe(first.playlistId);
        expect(playlists.list()).toHaveLength(2);
        expect(titlesOf(first.playlistId)).toEqual(['Track 1', 'Track 3']);
        expect(titlesOf(second.playlistId)).toEqual(['Track 2']);
    });

    it('replaces the contents and reports what changed', () => {
        const imported = playlists.importFromJellyfin({
            name: 'Favourites',
            sourceJellyfinId: 'jf-playlist-1',
            tracks: [track(1), track(2)],
        });

        const refreshed = playlists.importFromJellyfin({
            name: 'Favourites',
            sourceJellyfinId: 'jf-playlist-1',
            tracks: [track(3)],
        });

        expect(refreshed).toEqual({
            added: 1,
            created: false,
            playlistId: imported.playlistId,
            removed: 2,
        });
        expect(titlesOf(imported.playlistId)).toEqual(['Track 3']);
    });

    it('leaves a local rename alone on a refresh', () => {
        const imported = playlists.importFromJellyfin({
            name: 'Favourites',
            sourceJellyfinId: 'jf-playlist-1',
            tracks: [track(1)],
        });
        playlists.rename(imported.playlistId, 'The good ones');

        playlists.importFromJellyfin({
            name: 'Favourites',
            sourceJellyfinId: 'jf-playlist-1',
            tracks: [track(1)],
        });

        expect(playlists.get(imported.playlistId)?.name).toBe('The good ones');
    });

    it('ignores a local playlist that merely shares the name', () => {
        const local = playlists.create('Favourites');
        const imported = playlists.importFromJellyfin({
            name: 'Favourites',
            sourceJellyfinId: 'jf-playlist-1',
            tracks: [track(1)],
        });

        expect(imported.playlistId).not.toBe(local.id);
        expect(playlists.items(local.id)).toEqual([]);
        expect(playlists.get(imported.playlistId)?.sourceJellyfinId).toBe('jf-playlist-1');
        expect(playlists.get(local.id)?.sourceJellyfinId).toBeNull();
    });

    it('imports again after its local copy was deleted', () => {
        const first = playlists.importFromJellyfin({
            name: 'Favourites',
            sourceJellyfinId: 'jf-playlist-1',
            tracks: [track(1)],
        });
        playlists.remove(first.playlistId);

        // The tombstone still carries the source id, and matching it would
        // resurrect a playlist the listener deleted.
        const second = playlists.importFromJellyfin({
            name: 'Favourites',
            sourceJellyfinId: 'jf-playlist-1',
            tracks: [track(1)],
        });

        expect(second.created).toBe(true);
        expect(second.playlistId).not.toBe(first.playlistId);
    });
});
