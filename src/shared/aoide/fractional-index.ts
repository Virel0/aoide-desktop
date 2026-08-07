/**
 * Fractional indices: sortable strings with room between any two of them.
 *
 * `playlist_items.position` is one of these rather than an integer. With
 * integers, inserting at row 3 renumbers every row below it, so two devices
 * inserting concurrently produce dozens of conflicting updates and
 * last-writer-wins silently drops one of the inserts. A fractional index means
 * an insert writes exactly **one** row, and two concurrent inserts at the same
 * spot both survive — merely in an arbitrary relative order. Collaborative
 * playlists then work with no conflict resolution at all.
 *
 * Base 62 in ASCII order (digits, then uppercase, then lowercase), so JavaScript
 * string comparison, SQLite's default `BINARY` collation and Swift's comparison
 * of ASCII strings all agree on the order. That agreement is the whole contract:
 * these keys are generated on one device and sorted on another.
 */

const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const SMALLEST = DIGITS[0];
const LARGEST = DIGITS[DIGITS.length - 1];
/** Starting point for an empty list — the middle, so there is room both ways. */
const MIDDLE = DIGITS[Math.floor(DIGITS.length / 2)];

const valueOf = (character: string): number => DIGITS.indexOf(character);

/**
 * A key strictly greater than `key`, and short.
 *
 * **This is why appending does not bisect.** Bisecting towards infinity halves
 * the remaining space every time, so a thousand appends to the end of a playlist
 * produce keys hundreds of characters long — measured at 167 on iOS, against 33
 * for incrementing. Every one of those characters is stored on every device and
 * pushed through every sync, forever, for a playlist somebody merely added songs
 * to.
 */
const increment = (key: string): string => {
    for (let index = key.length - 1; index >= 0; index -= 1) {
        const digit = valueOf(key[index]);
        if (digit < DIGITS.length - 1) return key.slice(0, index) + DIGITS[digit + 1];
    }
    // Every digit is already the largest. Extend rather than overflow — and not
    // with the smallest digit, which would break the invariant below.
    return key + DIGITS[1];
};

/**
 * A key strictly less than `key`, and short.
 *
 * The mirror of `increment`, and needed for the same reason: bisecting towards
 * the front grows a key by a character every six prepends. Adding to the top of
 * a playlist is an ordinary thing to do.
 */
const decrement = (key: string): string => {
    for (let index = key.length - 1; index >= 0; index -= 1) {
        const digit = valueOf(key[index]);
        // Never step down *to* the smallest digit: a key ending there has
        // nothing insertable before it. Walking past those positions instead
        // lands on a shorter key that is still below the one asked about.
        if (digit > 1) return key.slice(0, index) + DIGITS[digit - 1];
    }
    // Every digit was already at the bottom, so go a level deeper.
    return SMALLEST.repeat(key.length) + MIDDLE;
};

/**
 * A key strictly between two others.
 *
 * Recursive: strip the common prefix, then place a digit in the gap. When the
 * two digits are adjacent there is no gap, so it descends a level and looks
 * again.
 */
const midpoint = (lower: string, upper: null | string): string => {
    if (upper !== null) {
        let shared = 0;
        while ((lower[shared] || SMALLEST) === upper[shared]) shared += 1;
        if (shared > 0) {
            return (
                upper.slice(0, shared) + midpoint(lower.slice(shared), upper.slice(shared) || null)
            );
        }
    }

    const lowerDigit = lower ? valueOf(lower[0]) : 0;
    const upperDigit = upper === null ? DIGITS.length : valueOf(upper[0]);

    if (upperDigit - lowerDigit > 1) {
        return DIGITS[Math.round(0.5 * (lowerDigit + upperDigit))];
    }

    if (upper !== null && upper.length > 1) {
        // Adjacent digits, but `upper` continues — anything at `upper`'s first
        // digit alone already sorts below it.
        return upper.slice(0, 1);
    }

    // Adjacent, and `upper` is a single digit. Keep `lower`'s digit and find
    // room further down.
    return DIGITS[lowerDigit] + midpoint(lower.slice(1), null);
};

/**
 * The invariant everything rests on: **a generated key never ends in the
 * smallest digit.**
 *
 * Nothing sorts between `"a"` and `"a0"` — any key between them would have to
 * begin `"a"` and continue with something below `"0"`, and there is nothing
 * below `"0"`. A key ending that way is a position no one can ever insert
 * before, and the failure is a silent refusal to reorder rather than an error.
 */
export const isWellFormedIndex = (key: string): boolean =>
    key.length > 0 &&
    !key.endsWith(SMALLEST) &&
    [...key].every((character) => DIGITS.includes(character));

/**
 * A position between `lower` and `upper`, either of which may be absent.
 *
 * `null` for `lower` means the top of the list, `null` for `upper` means the
 * bottom. Both null is the first item in an empty one.
 */
export const positionBetween = (lower: null | string, upper: null | string): string => {
    if (lower !== null && upper !== null && lower >= upper) {
        throw new Error(`Positions are out of order: ${lower} is not before ${upper}`);
    }

    if (lower === null && upper === null) return MIDDLE;
    if (upper === null) return increment(lower as string);
    if (lower === null) return decrement(upper);
    return midpoint(lower, upper);
};

/**
 * `count` positions in order, to append a batch to the end of a list.
 *
 * Appending one at a time gives the same answer; this exists so importing a
 * playlist of six hundred tracks does not walk the list six hundred times.
 */
export const positionsAfter = (lower: null | string, count: number): string[] => {
    const positions: string[] = [];
    let previous = lower;

    for (let index = 0; index < count; index += 1) {
        previous = positionBetween(previous, null);
        positions.push(previous);
    }

    return positions;
};

export const FRACTIONAL_INDEX_INTERNALS = { DIGITS, LARGEST, MIDDLE, SMALLEST };
