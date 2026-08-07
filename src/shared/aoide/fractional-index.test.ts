import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

import { isWellFormedIndex, positionBetween, positionsAfter } from './fractional-index';

/** A tiny deterministic generator, so a failure can be reproduced exactly. */
const seededRandom = (seed: number) => {
    let state = seed;
    return () => {
        state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
        return state / 2_147_483_648;
    };
};

describe('positionBetween', () => {
    it('starts an empty list in the middle, leaving room both ways', () => {
        const first = positionBetween(null, null);

        expect(positionBetween(null, first) < first).toBe(true);
        expect(positionBetween(first, null) > first).toBe(true);
    });

    it('places a key strictly between two others', () => {
        const between = positionBetween('a', 'b');
        expect(between > 'a').toBe(true);
        expect(between < 'b').toBe(true);
    });

    it('keeps finding room between two keys that are already adjacent', () => {
        let lower = 'a';
        const upper = 'b';

        for (let index = 0; index < 50; index += 1) {
            const next = positionBetween(lower, upper);
            expect(next > lower).toBe(true);
            expect(next < upper).toBe(true);
            lower = next;
        }
    });

    // The prepend chain looks like "0001", so it never exercises a key whose
    // non-zero prefix ends in a one. `increment` produces exactly that — "z1" —
    // and a key arriving from another device may too.
    it('steps below a key whose prefix is not all zeros', () => {
        for (const upper of ['z1', 'a1', '1', 'zz1', 'Z1']) {
            const below = positionBetween(null, upper);
            expect(below < upper).toBe(true);
            expect(isWellFormedIndex(below)).toBe(true);
        }
    });

    it('refuses positions given in the wrong order', () => {
        expect(() => positionBetween('b', 'a')).toThrow(/out of order/);
        expect(() => positionBetween('a', 'a')).toThrow(/out of order/);
    });
});

describe('the invariant: never end in the smallest digit', () => {
    // Nothing sorts between "a" and "a0". A key ending that way is a position
    // nobody can ever insert before, and it fails as a silent refusal to
    // reorder rather than as an error.
    it('holds for a long run of appends', () => {
        let key = positionBetween(null, null);
        for (let index = 0; index < 500; index += 1) {
            key = positionBetween(key, null);
            expect(isWellFormedIndex(key)).toBe(true);
        }
    });

    it('holds for a long run of prepends', () => {
        let key = positionBetween(null, null);
        for (let index = 0; index < 500; index += 1) {
            key = positionBetween(null, key);
            expect(isWellFormedIndex(key)).toBe(true);
        }
    });

    it('holds when repeatedly splitting the same gap', () => {
        let lower = positionBetween(null, null);
        const upper = positionBetween(lower, null);

        for (let index = 0; index < 500; index += 1) {
            lower = positionBetween(lower, upper);
            expect(isWellFormedIndex(lower)).toBe(true);
        }
    });

    it('rejects a key that ends in the smallest digit', () => {
        expect(isWellFormedIndex('a0')).toBe(false);
        expect(isWellFormedIndex('0')).toBe(false);
        expect(isWellFormedIndex('a1')).toBe(true);
    });
});

describe('key length', () => {
    // The measured reason appending increments instead of bisecting. Bisecting
    // towards infinity reached 167 characters over a thousand appends on iOS.
    it('stays short over a thousand appends', () => {
        let key = positionBetween(null, null);
        for (let index = 0; index < 1000; index += 1) {
            key = positionBetween(key, null);
        }

        expect(key.length).toBeLessThan(40);
    });

    it('stays short over a thousand prepends', () => {
        let key = positionBetween(null, null);
        for (let index = 0; index < 1000; index += 1) {
            key = positionBetween(null, key);
        }

        expect(key.length).toBeLessThan(60);
    });

    // Splitting one gap a thousand times genuinely has to grow — there is no
    // encoding that avoids it. This only pins that it grows linearly and slowly
    // rather than exploding.
    it('grows gracefully when one gap is split repeatedly', () => {
        let lower = 'a';
        for (let index = 0; index < 1000; index += 1) {
            lower = positionBetween(lower, 'b');
        }

        expect(lower.length).toBeLessThan(220);
    });
});

describe('positionsAfter', () => {
    it('returns ascending positions', () => {
        const positions = positionsAfter(null, 10);

        expect(positions).toHaveLength(10);
        expect([...positions].sort()).toEqual(positions);
        expect(new Set(positions).size).toBe(10);
    });

    it('continues from an existing tail', () => {
        const first = positionsAfter(null, 3);
        const next = positionsAfter(first[2], 3);

        expect(next[0] > first[2]).toBe(true);
    });

    it('matches appending one at a time', () => {
        const batch = positionsAfter('a', 20);

        let key = 'a';
        const individually = Array.from({ length: 20 }, () => {
            key = positionBetween(key, null);
            return key;
        });

        expect(batch).toEqual(individually);
    });
});

describe('random insertion', () => {
    // The property that matters, exercised the way a playlist is actually
    // used — inserted into at arbitrary points, thousands of times.
    it('keeps a list totally ordered under arbitrary insertions', () => {
        const random = seededRandom(20_260_807);
        const list: string[] = [positionBetween(null, null)];

        for (let step = 0; step < 2000; step += 1) {
            const at = Math.floor(random() * (list.length + 1));
            const lower = at === 0 ? null : list[at - 1];
            const upper = at === list.length ? null : list[at];
            const key = positionBetween(lower, upper);

            expect(isWellFormedIndex(key)).toBe(true);
            list.splice(at, 0, key);
        }

        expect(new Set(list).size).toBe(list.length);
        for (let index = 1; index < list.length; index += 1) {
            expect(list[index - 1] < list[index]).toBe(true);
        }
    });
});

describe('agreement with SQLite', () => {
    // These keys are generated in one process and sorted in another, by SQLite,
    // in `ORDER BY position`. A disagreement between JavaScript's comparison and
    // SQLite's BINARY collation would show up as a playlist in the wrong order
    // with every individual key perfectly valid.
    it('sorts identically to ORDER BY on the same keys', () => {
        const random = seededRandom(1_234_567);
        const list: string[] = [positionBetween(null, null)];

        for (let step = 0; step < 500; step += 1) {
            const at = Math.floor(random() * (list.length + 1));
            const lower = at === 0 ? null : list[at - 1];
            const upper = at === list.length ? null : list[at];
            list.splice(at, 0, positionBetween(lower, upper));
        }

        const db = new DatabaseSync(':memory:');
        db.exec('CREATE TABLE p (position TEXT NOT NULL)');
        const insert = db.prepare('INSERT INTO p (position) VALUES (?)');
        // Shuffled going in, so the ordering has to come from the collation.
        for (const position of [...list].reverse()) insert.run(position);

        const sorted = (
            db.prepare('SELECT position FROM p ORDER BY position').all() as Array<{
                position: string;
            }>
        ).map((row) => row.position);

        expect(sorted).toEqual(list);
        db.close();
    });
});
