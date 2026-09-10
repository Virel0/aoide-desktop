/**
 * What the listener said they were doing while a track played.
 *
 * A closed set of four, and the closure is the whole point. The tag is written
 * onto a `play_events` row, the row becomes an op payload verbatim, and the
 * payload reaches the phone — so `activity` is a column that travels, and both
 * clients have to mean the same four things by it. A fifth value invented on
 * one side would arrive on the other as a tag nothing can query and nothing can
 * show, and because play events are append-only it would stay there forever.
 *
 * The values are the phone's, spelled the same: `CurationKit`'s `Activity`.
 * Lower case because that is what is stored, not what is shown — the labels are
 * i18n keys under `aoide.activity.*`, so a translation never changes a value
 * that has been written to a row.
 *
 * **Absent or null means untagged, and untagged is the default.** Nothing here
 * detects an activity, guesses one, or fills one in; a listener who never opens
 * the picker records exactly what they always did.
 *
 * This module is the only place the four strings are spelled. `wiring.test.ts`
 * greps for a second copy, because the failure mode of a second copy is not a
 * type error — it is one file's `"focus"` quietly outliving a rename in the
 * other, and a query that silently matches nothing.
 */

/**
 * The four, in the order they are offered. Ordering is a presentation choice
 * and nothing reads it as an index, so it can change; the strings cannot.
 */
export const ACTIVITIES = ['gaming', 'focus', 'chores', 'commute'] as const;

/** What a play event's `activity` column may hold, other than null. */
export type Activity = (typeof ACTIVITIES)[number];

/**
 * Whether an unknown value is one of the four.
 *
 * Takes `unknown` rather than `string` on purpose: every caller is at a boundary
 * where the value did not come from this process — an IPC argument from the
 * renderer, a column of a row a sidecar handed over — and a signature that
 * demanded a string would push the cast to the caller, which is where it would
 * be got wrong.
 */
export const isActivity = (value: unknown): value is Activity =>
    typeof value === 'string' && (ACTIVITIES as readonly string[]).includes(value);

/**
 * An activity, or null for anything that is not one.
 *
 * Null rather than a throw, and that is the load-bearing decision. The values
 * this rejects arrive inside somebody else's play event: a build newer than this
 * one adds a fifth activity, the phone records a listen under it, and the op
 * reaches this device. Refusing the op would quarantine a real listen — lost
 * history, because a quarantined op is never retried — so the listen is kept and
 * only the tag this build cannot understand is dropped. The row is still a play;
 * it is merely untagged here.
 *
 * No trimming and no case folding. `" Gaming "` is not a near miss to be
 * rescued, it is evidence that something upstream is writing the column by hand,
 * and quietly repairing it would hide that for as long as it took to matter.
 */
export const parseActivity = (value: unknown): Activity | null =>
    isActivity(value) ? value : null;
