import { describe, expect, it } from 'vitest';

import { ACTIVITIES, Activity, isActivity, parseActivity } from './activity';

/**
 * The value set is a contract with the phone, so the test spells it out rather
 * than deriving it from the module under test. Deriving it would pass for any
 * four strings, including four wrong ones, which is exactly the change that has
 * to fail here.
 */
describe('the closed set', () => {
    it('is these four strings and no others', () => {
        expect([...ACTIVITIES]).toEqual(['gaming', 'focus', 'chores', 'commute']);
    });

    it('accepts every one of them', () => {
        for (const activity of ACTIVITIES) {
            expect(isActivity(activity)).toBe(true);
            expect(parseActivity(activity)).toBe(activity);
        }
    });
});

describe('parseActivity', () => {
    // Untagged is the default and the absent case, and both spellings of absent
    // have to reach it: a column SQLite gives back as null, and a field the
    // phone simply did not encode.
    it('calls absence untagged rather than an error', () => {
        expect(parseActivity(null)).toBeNull();
        expect(parseActivity(undefined)).toBeNull();
    });

    // The case this exists for: a build newer than this one invents a fifth
    // activity, records a listen under it, and syncs. The listen is kept; the
    // tag is dropped.
    it('drops a value a future build invented', () => {
        expect(parseActivity('driving')).toBeNull();
        expect(isActivity('driving')).toBe(false);
    });

    // Not near misses to be rescued. Something writing the column by hand is
    // what these mean, and repairing them would hide it.
    it('does not rescue a near miss', () => {
        expect(parseActivity('Gaming')).toBeNull();
        expect(parseActivity(' gaming')).toBeNull();
        expect(parseActivity('gaming ')).toBeNull();
        expect(parseActivity('GAMING')).toBeNull();
    });

    it('refuses junk of every other shape', () => {
        const junk: unknown[] = [
            0,
            1,
            -1,
            Number.NaN,
            '',
            true,
            false,
            [],
            ['gaming'],
            { activity: 'gaming' },
            new String('gaming'),
            Symbol('gaming'),
            () => 'gaming',
        ];

        for (const value of junk) {
            expect(isActivity(value)).toBe(false);
            expect(parseActivity(value)).toBeNull();
        }
    });

    // The guard is what lets a caller hand the result straight to a typed
    // field; if it narrowed to anything wider this would not compile.
    it('narrows to the union', () => {
        const value: unknown = 'chores';
        const activity: Activity | null = parseActivity(value);
        expect(activity).toBe('chores');
    });
});
